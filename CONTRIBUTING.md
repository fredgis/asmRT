# Contributing to asmRT

asmRT is a Rust runtime for durable agents, built on [asmDB](https://github.com/fredgis/asmDB). Contributions should make execution easier to recover, inspect or test. Open an issue before changing the durability contract or introducing a new workflow type.

## Set up locally

Follow the [README](README.md#run-the-demo) for Rust, Node.js, the sibling asmDB checkout and Ollama. Windows x86-64 is the verified platform; report your OS and toolchain when testing another platform.

```powershell
Set-Location "$HOME\repo-asmrt"
$env:ASMRT_ASMDB_REPO = "$HOME\repo-asmdb"
```

Read the [architecture](Docs/ARCHITECTURE.md) for process boundaries and the [domain vocabulary](CONTEXT.md) before changing runtime behavior. Keep temporary runs under ignored `.asmrt` directories, never in tracked source.

## Make a focused change

- Keep asmDB's engine and file format unchanged. asmRT uses its existing MCP/stdio bridge.
- Preserve saved-plan, job and reply compatibility. Never silently reinterpret an existing handler version or rewrite saved hashes.
- Add a focused regression test for changed behavior, including the relevant interruption boundary. Do not claim exactly-once external effects.
- Keep real replies intact. Model fixtures belong in tests; the application must not replace failed inference with scripted dialogue.
- For console changes, check Overview and Details, light and dark themes, narrow screens, keyboard focus, reset and disconnected states. Capture screenshots from a real run; clearly label any test fixture.

## Workflow changes

Eight bounded agent workflows are implemented: **relay, discussion, conditional graph, role-based team, human approval, agent handoff, hybrid orchestration and agent loop**. Their canonical kinds and current v1 contracts are listed in [WORKFLOWS.md](Docs/WORKFLOWS.md). They share the same State Actor and saved-file formats; their ordering, input sets and control decisions differ.

A new workflow needs its own explicit contract for ordering, inputs, completion, retries and recovery. Keep Rust's plan validation and execution in [src/chat.rs](src/chat.rs), the controller's topology observer in [conversation-story.mjs](visualizer/conversation-story.mjs), and the browser's graph mapping in [workflow-catalog.mjs](visualizer/public/workflow-catalog.mjs) consistent. Update the workflow reference, architecture, domain vocabulary and README as appropriate. Workflow versions and job-handler versions are separate. Arbitrary user-defined graphs remain a future extension; fixed conditional routing is already implemented.

## Validate your change

Start with the smallest test selection covering the change. For a runtime or controller change, these broader checks are available:

```powershell
& .\scripts\cargo.ps1 fmt --all --check
& .\scripts\cargo.ps1 test --locked --quiet
& .\scripts\cargo.ps1 clippy --locked --all-targets '--' -D warnings
# Build the executable that the Node integration tests launch
& .\scripts\cargo.ps1 build --locked --quiet
node --test .\visualizer\test\*.test.mjs
```

The Node integration tests require `ASMRT_ASMDB_REPO` and the built Rust executable. Conversation tests use a test-only local model fixture, so no Ollama download is needed. Native Node cases skip when `ASMRT_ASMDB_REPO` is unset; once enabled, a missing executable is a failure, not a successful check. The pure console tests can run alone with `node --test .\visualizer\test\console.test.mjs`.

Rust's real-engine integration tests are ignored by default. Run them explicitly, and use the separate Windows fault harness when changing persistence or process cleanup:

```powershell
& .\scripts\cargo.ps1 test --locked --quiet '--' --ignored --test-threads=1
# Windows with PowerShell 7+: actual Rust/bridge/engine process termination
& .\scripts\test-recovery.ps1 -AsmdbDir $env:ASMRT_ASMDB_REPO
```

Use isolated run directories and controller ports. Do not interrupt someone else's running demo or overwrite its active executable to run tests.

## Send a pull request

Explain the problem, the behavioral change and the checks you ran. Include before/after screenshots for visible changes and describe any saved-data compatibility impact. Keep unrelated cleanup out of the diff. Do not commit credentials, local run folders, model files or machine-specific build output.

By submitting a contribution, you agree to license it under asmRT's [MIT license](LICENSE). asmDB, model weights and other dependencies retain their own licenses.
