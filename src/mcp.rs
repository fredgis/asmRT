//! +--------------------------------------------------------------------+
//! | asmRT :: mcp.rs -- owned bridge and bounded transport                |
//! +--------------------------------------------------------------------+
//! Starts one Node MCP bridge and validates newline-delimited JSON-RPC,
//! embedded asmDB results, and paginated startup records. A failed or
//! timed-out write has an unknown outcome: recovery, not retry, resolves it.

use std::{collections::BTreeMap, process::Stdio, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

use crate::{Config, Error, Record, Result, Task};

const MAX_FRAME: usize = 1024 * 1024;
const PAGE_SIZE: usize = 1000;
const PROTOCOL: &str = "2024-11-05";

pub(crate) struct Mcp {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    request_timeout: Duration,
    next_id: u64,
}

impl Mcp {
    // The client owns one bridge; initialization must succeed before any database calls.
    pub async fn open(config: &Config) -> Result<Self> {
        let executable =
            config
                .asmdb_dir
                .join("build")
                .join(if cfg!(windows) { "asmdb.exe" } else { "asmdb" });
        let mut command = Command::new("node");
        command
            .arg(config.asmdb_dir.join("mcp").join("src").join("server.js"))
            .current_dir(&config.data_dir)
            .env("ASMDB_EXE", executable)
            .env("ASMDB_DIR", &config.data_dir)
            .env("ASMDB_DB", "asmrt")
            .env("ASMDB_CAPACITY", "small")
            .env(
                "ASMDB_TIMEOUT_MS",
                config.request_timeout.as_millis().to_string(),
            )
            .env("ASMDB_MAX_OUTPUT_BYTES", MAX_FRAME.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(transport)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| transport("missing stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| transport("missing stdout"))?;
        let mut client = Self {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
            request_timeout: config.request_timeout,
            next_id: 0,
        };
        let setup = client.initialize().await;
        if let Err(error) = setup {
            let _ = client.close().await;
            return Err(error);
        }
        Ok(client)
    }

    async fn initialize(&mut self) -> Result<()> {
        let result = self
            .rpc(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL,
                    "capabilities": {},
                    "clientInfo": {"name": "asmrt", "version": env!("CARGO_PKG_VERSION")}
                }),
            )
            .await?;
        if result["protocolVersion"] != PROTOCOL || result["serverInfo"]["name"] != "asmdb" {
            return Err(transport("unsupported MCP protocol or server identity"));
        }
        let notification = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        timeout(self.request_timeout, self.write_message(&notification))
            .await
            .map_err(|_| transport("initialization notification timed out"))??;
        Ok(())
    }

    async fn write_message(&mut self, message: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(message).map_err(transport)?;
        bytes.push(b'\n');
        self.stdin
            .as_mut()
            .ok_or(Error::Closed)?
            .write_all(&bytes)
            .await
            .map_err(transport)
    }

    // One in-flight request gets a single deadline; reject unrelated replies and unbounded output.
    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        // Unlike task IDs (decimal strings), JSON-RPC IDs are JSON numbers and
        // must fit the bridge's exact JavaScript integer range.
        self.next_id = self
            .next_id
            .checked_add(1)
            .filter(|id| *id <= 9_007_199_254_740_991)
            .ok_or_else(|| transport("request ID exhausted"))?;
        let id = self.next_id;
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        // The deadline covers writing and reading together. There is deliberately
        // no automatic resend: asmDB may have applied a write before stdout failed.
        timeout(self.request_timeout, async {
            self.write_message(&message).await?;
            for _ in 0..64 {
                let mut line = Vec::new();
                let read = (&mut self.stdout)
                    .take((MAX_FRAME + 1) as u64)
                    .read_until(b'\n', &mut line)
                    .await
                    .map_err(transport)?;
                if read == 0 {
                    return Err(transport("bridge closed stdout before replying"));
                }
                if line.len() > MAX_FRAME || !line.ends_with(b"\n") {
                    return Err(transport("oversized or incomplete MCP frame"));
                }
                let message: Value = serde_json::from_slice(&line).map_err(transport)?;
                if message["jsonrpc"] != "2.0" {
                    return Err(transport("invalid JSON-RPC version"));
                }
                if message.get("id").is_none() && message["method"].is_string() {
                    continue;
                }
                if message["id"].as_u64() != Some(id) {
                    return Err(transport("unexpected response ID"));
                }
                if let Some(error) = message.get("error") {
                    return Err(transport(format!("JSON-RPC error: {error}")));
                }
                return message
                    .get("result")
                    .cloned()
                    .ok_or_else(|| transport("missing MCP result"));
            }
            Err(transport("too many notifications without a response"))
        })
        .await
        .map_err(|_| transport(format!("{method} timed out; outcome is unknown")))?
    }

    // Validate both MCP's content envelope and asmDB's embedded result status.
    pub async fn tool(&mut self, name: &str, arguments: Value) -> Result<Value> {
        let result = self
            .rpc("tools/call", json!({"name": name, "arguments": arguments}))
            .await?;
        if result["isError"].as_bool() == Some(true) {
            return Err(Error::Backend(result.to_string()));
        }
        let content = result["content"]
            .as_array()
            .filter(|content| content.len() == 1)
            .ok_or_else(|| transport("expected one MCP text result"))?;
        let text = content[0]["text"]
            .as_str()
            .filter(|_| content[0]["type"] == "text")
            .ok_or_else(|| transport("missing MCP text result"))?;
        let payload: Value = serde_json::from_str(text).map_err(transport)?;
        match payload["ok"].as_bool() {
            Some(true) => Ok(payload),
            Some(false) => Err(Error::Backend(format!(
                "{}: {}",
                payload["errorKind"], payload["error"]
            ))),
            None => Err(transport("missing asmDB result status")),
        }
    }

    // Validate a complete, duplicate-free scan before startup recovery is allowed to mutate rows.
    pub async fn load(&mut self, max_tasks: usize) -> Result<BTreeMap<u64, Task>> {
        let mut tasks = BTreeMap::new();
        let mut offset = 0;
        loop {
            let page = self
                .tool("db_list", json!({"limit": PAGE_SIZE, "offset": offset}))
                .await?;
            let rows = page["rows"]
                .as_array()
                .ok_or_else(|| transport("missing row list"))?;
            let has_more = page["hasMore"]
                .as_bool()
                .ok_or_else(|| transport("missing pagination status"))?;
            if rows.len() > PAGE_SIZE || (has_more && rows.len() != PAGE_SIZE) {
                return Err(transport("inconsistent pagination"));
            }
            for row in rows {
                let record: Record = serde_json::from_value(row.clone()).map_err(transport)?;
                let task = Task::decode(&record)?;
                if tasks.insert(task.id(), task).is_some() {
                    return Err(transport("duplicate task in startup scan"));
                }
                if tasks.len() > max_tasks {
                    return Err(Error::Invalid(format!(
                        "database exceeds the configured limit of {max_tasks} tasks"
                    )));
                }
            }
            if !has_more {
                return Ok(tasks);
            }
            offset += rows.len();
        }
    }

    pub async fn close(&mut self) -> Result<()> {
        // EOF invokes the existing bridge's shutdown hook, which closes its engine.
        drop(self.stdin.take());
        match timeout(Duration::from_secs(4), self.child.wait()).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            Ok(Ok(status)) => Err(transport(format!("bridge exited with {status}"))),
            Ok(Err(error)) => Err(transport(error)),
            Err(_) => {
                let _ = timeout(Duration::from_secs(2), self.child.kill()).await;
                Err(transport(
                    "bridge did not shut down in time; forced termination requested",
                ))
            }
        }
    }
}

fn transport(message: impl std::fmt::Display) -> Error {
    Error::Transport(message.to_string())
}
