<div align="center">
  <img src="Docs/assets/asmrt-banner.png" alt="asmRT: durable coordination over asmDB" width="100%">
  <h1>asmRT</h1>
  <p><strong>Agents stop. Work survives.</strong></p>
</div>

asmRT is a Rust runtime for recoverable agent workflows, built on **[asmDB, the assembly database](https://github.com/fredgis/asmDB)**.

A transcript tells you what an agent said. Continuing after a crash also requires knowing which instructions it received, which replies it used, and whether its work was committed. asmRT saves that execution context so the next process can determine what remains to run.

The goal is a small, inspectable execution layer for agents whose work needs to outlive a process. Today's prototype demonstrates that with a real local-model conversation and an actual crash.

![Overview: four agents, an actual saved reply and graphical asmDB memory](Docs/assets/screenshots/conversation.png)

## What actually runs

Rust uses **asmDB's existing MCP/stdio bridge** to read and update durable task state. The assembly engine stays unchanged. Full instructions and replies live in files alongside the database.

The demo calls **`qwen3.5:0.8b` through local Ollama**. One model serves four roles: Planner, Builder, Critic and Editor. Replies are generated, not scripted; no cloud API key is required. The small model can make mistakes. The demonstration is about recovering work, not proving the quality of its dinner advice.

## See recovery happen

The agents plan pizza night for eight friends on $40. In round two, the oven breaks. The controller kills the Rust process before turn 5 makes its model call, then restarts it.

Replies 1–4 survive. Turn 5 retries and the conversation continues. A final replay reports `completed_now = 0` and `model_calls_now = 0`: completed work did not run again.

**Overview** keeps the story playful: large robots, the full conversation colored by agent, and visual memory. Memory tiles jump to a reply; **Latest reply** returns to the end of the conversation. A check means the native database reported completion, not merely that a reply file exists.

**Details** shows the full conversation beside asmDB, with an event dock below them. Inspect the saved instructions, attempts and replies. [See the technical console and recovery evidence](Docs/ARCHITECTURE.md#7-browser-controller-and-observable-evidence).

## Run the demo

Verified on Windows x86-64. You need Rust/Cargo with its native linker, Node.js, a built [asmDB checkout with MCP dependencies](https://github.com/fredgis/asmDB), and Ollama running locally. The example assumes sibling `repo-asmrt` and `repo-asmdb` folders.

```powershell
Set-Location "$HOME\repo-asmrt"
ollama pull qwen3.5:0.8b
& .\scripts\visualize.ps1 -AsmdbDir "$HOME\repo-asmdb"
```

Open **http://127.0.0.1:8787** and click **Start conversation**. The same button pauses and resumes. Keep the controller terminal open.

**Reset demo** stops the runtime and clears the view after confirmation. It preserves old run folders and waits for you to start a fresh run. To change the mission, reset, edit it in Details, then start. Refreshing or switching views does not restart the conversation. Pause holds future steps; an inference already running finishes at its next checkpoint.

## Workflow 1: sequential conversation

`conversation.sequential`, version `1`:

```text
Planner → Builder → Critic → Editor
          two rounds by default
```

Rust supplies each turn with **all earlier committed replies** and runs one model call at a time. It saves and commits the reply before advancing. The agents do not poll a message bus; the runtime provides their context. The browser controller only paces the demo.

This is the first agent-workflow contract. Its version is separate from job-handler versions. [Read the ordering and recovery rules](Docs/WORKFLOWS.md).

## Product direction

The ambition is to make recoverable execution reusable beyond this conversation: longer-running agent jobs, additional model and tool handlers, and explicit workflow types for parallel branches or conditional routing. These are future directions, not implemented capabilities. Each new type will need its own rules for context, completion and recovery.

The prototype currently recovers known jobs in one local runtime. A valid saved reply can be reused; inference lost before publication may run again. It does not promise exactly-once external effects, distributed orchestration or faster LLM inference. FFI and a CDC follower are not shipped.

Back up the whole run directory, including the database, instructions and reply files. The [detailed architecture](Docs/ARCHITECTURE.md) explains the persistence boundaries and limitations; [CONTEXT.md](CONTEXT.md) defines the project vocabulary.

## Contribute

Bug reports, recovery tests and focused improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and pull requests.

asmRT is licensed under **[MIT](LICENSE)**. asmDB, model weights and other dependencies retain their own licenses.
