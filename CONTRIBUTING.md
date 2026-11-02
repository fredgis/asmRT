# Contributing to asmRT

asmRT is a local Rust runtime prototype over [asmDB](https://github.com/fredgis/asmDB). Contributions should make execution easier to recover, inspect or test. Open an issue before changing the durability contract or introducing a new workflow type.

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

The implemented agent workflow is **Workflow 1: sequential conversation**, identified by `conversation.sequential`, version `1`. Rust supplies every role with all earlier committed replies and executes one model call at a time.

A new workflow needs its own explicit contract for ordering, inputs, completion, retries and recovery. Update [WORKFLOWS.md](Docs/WORKFLOWS.md), the architecture, domain vocabulary and README as appropriate. Workflow versions and job-handler versions are separate. Parallel and conditional agent workflows are not currently implemented.

## Validate your change

Start with the smallest test selection covering the change. For a runtime or controller change, these broader checks are available:

```powershell
& .\scripts\cargo.ps1 fmt --all --check
& .\scripts\cargo.ps1 test --locked --quiet
& .\scripts\cargo.ps1 clippy --locked --all-targets '--' -D warnings
node --test .\visualizer\test\*.test.mjs
```

The Node integration tests use real Rust and asmDB, with a test-only local model fixture. They do not need an Ollama model download. Run fault tests when changing persistence or process cleanup:

```powershell
& .\scripts\cargo.ps1 test --locked --quiet '--' --ignored --test-threads=1
```

Use isolated run directories and controller ports. Do not interrupt someone else's running demo or overwrite its active executable to run tests.

## Send a pull request

Explain the problem, the behavioral change and the checks you ran. Include before/after screenshots for visible changes and describe any saved-data compatibility impact. Keep unrelated cleanup out of the diff. Do not commit credentials, local run folders, model files or machine-specific build output.

By submitting a contribution, you agree to license it under asmRT's [MIT license](LICENSE). asmDB, model weights and other dependencies retain their own licenses.
