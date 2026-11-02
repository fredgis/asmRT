// Project acknowledged deterministic-demo state into scene copy, controls, and pacing.

// The catalog follows publication and completion separately, then recovery and zero-work replay.
const scenes = [
  ['queued', 'Queue', 'First, put the work in asmDB.', 'Eight pending records, one per result file. The workers have not claimed anything yet.', 'database', 'Assign four tasks', 'next', 7000],
  ['assigned', 'Work', 'Four workers claim four tasks.', 'Each owner is saved in asmDB before work starts. The other four records stay pending.', 'workers', 'Write the first files', 'next', 6500],
  ['published', 'Work', 'Four files exist. They are not committed yet.', 'The results are on disk, but their records still say running. Writing a file and recording completion are separate steps.', 'files', 'Commit completed records', 'next', 8000],
  ['committed', 'Work', 'Now asmDB remembers the completed work.', 'Four records say completed and contain a result reference. These tasks will be skipped when Rust restarts.', 'database', 'Assign the remaining tasks', 'next', 6500],
  ['crash-next', 'Crash', 'Four tasks finished. Four just started.', 'The next four assignments are saved. We will kill the real Rust process before these workers write their results.', 'workers', 'Kill the Rust process', 'interrupt', 6000],
  ['crashed', 'Crash', 'Rust is gone. Let us check what survived.', 'The workers are stopped. The console retains its last confirmed read; we must reopen asmDB to read it again.', 'database', 'Restart Rust and reread asmDB', 'resume', 8000],
  ['recovered', 'Recover', 'The database knows where to resume.', 'Completed records stay completed. Interrupted assignments are pending again, ready for another attempt.', 'database', 'Retry unfinished work', 'next', 8000],
  ['retrying', 'Recover', 'Resume only unfinished work.', 'Unfinished work receives new assignments. Completed records remain unchanged.', 'workers', 'Publish these results', 'next', 6500],
  ['recovered-files', 'Recover', 'The resumed results are ready.', 'The restarted workers have published their results. Recording completion is a separate step.', 'files', 'Record these completions', 'next', 6500],
  ['completed', 'Verify', 'All eight are done. Restart once more.', 'We will reopen the same database and check every completed result, without requesting any new work.', 'database', 'Verify a zero-work replay', 'resume', 7000],
  ['verified', 'Verify', 'Restarted. Zero tasks repeated.', 'Eight completed records. Eight result files checked. Zero new tasks executed during the final replay.', 'files', 'Play again', null, 0],
];

export function describeStory({ phase, checkpoint, tasks, summary, database }) {
  let index;
  const completed = tasks.filter(task => task.state === 'completed').length;
  const running = tasks.filter(task => task.state === 'running');
  const retried = running.some(task => BigInt(task.attempt) > 1n);
  // Only paused, interrupted, and finished states have a stable story frame.
  if (phase === 'paused') {
    if (checkpoint?.stage === 'ready') index = tasks.some(task => task.attempt !== '0') ? 6 : 0;
    else if (checkpoint?.stage === 'claimed') index = retried ? 7 : completed === 4 ? 4 : 1;
    else if (checkpoint?.stage === 'published') index = retried ? 8 : 2;
    else if (checkpoint?.stage === 'completed') index = 3;
  } else if (phase === 'interrupted') index = 5;
  else if (phase === 'finished') index = summary?.completed_now === 0 ? 10 : 9;
  if (index === undefined) return null;
  const [id, chapter, title, description, focus, next_label, action, duration_ms] = scenes[index];
  const result = { index, total: scenes.length, scene: { id, chapter, title, description, focus, next_label }, action, duration_ms };
  // Adapt observed counts and recovery context without mutating the shared scene catalog.
  if (index === 1) {
    if (running.length !== 4) result.scene.title = 'Work is assigned before it starts.';
    result.scene.description = `Each owner is saved in asmDB before work starts. ${tasks.filter(task => task.state === 'pending').length} records stay pending.`;
  }
  if (index === 2 && running.length !== 4) result.scene.title = `${running.length === 1 ? 'One file exists' : `${running.length} files exist`}. Completion is not recorded yet.`;
  if (index === 3) result.scene.description = `${completed} records say completed and contain a result reference. These tasks will be skipped when Rust restarts.`;
  if (index === 6) result.scene.description = `${completed} completed records are preserved. ${tasks.length - completed} unfinished tasks are pending again.`;
  if (index === 7) result.scene.description = `${completed} completed records remain unchanged. Active assignments are saved with their new attempt counts.`;
  if (index === 8) result.scene.description = `${completed} completed records remain unchanged. Published results may reuse identical files already on disk.`;
  if (index === 5 && !database) {
    result.scene.title = 'This saved run is stopped.';
    result.scene.description = 'No records have been read by this controller yet. Resume to reopen the saved database.';
    result.duration_ms = 0;
  }
  return result;
}
