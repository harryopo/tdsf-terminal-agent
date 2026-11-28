export function createStore(db, BackendError) {
  const fail = () => { throw new BackendError("database_unavailable", 503); };
  const rows = (result) => {
    if (!result || result.error) fail();
    return result.data || [];
  };
  const learnerOut = (row) => ({ id: row.id, tokenHash: row.token_hash, createdAt: row.created_at, lastSeenAt: row.last_seen_at });
  const attemptOut = (row) => ({
    id: row.id,
    learnerId: row.learner_id,
    taskId: row.task_id,
    stepId: row.step_id,
    taskVersion: row.task_version,
    commandSha256: row.command_sha256,
    outputSha256: row.output_sha256,
    status: row.status,
    evidenceMatched: row.evidence_matched,
    durationMs: row.duration_ms,
    createdAt: row.created_at
  });
  const progressOut = (row) => ({
    taskId: row.task_id,
    stepId: row.step_id,
    taskVersion: row.task_version,
    status: row.status,
    firstCompletedAt: row.first_completed_at,
    lastCompletedAt: row.last_completed_at
  });
  const learnerColumns = "id,token_hash,created_at,last_seen_at";
  const attemptColumns = "id,learner_id,task_id,step_id,task_version,command_sha256,output_sha256,status,evidence_matched,duration_ms,created_at";
  const progressColumns = "task_id,step_id,task_version,status,first_completed_at,last_completed_at";

  return {
    async createLearner(learner) {
      const row = { id: learner.id, token_hash: learner.tokenHash, created_at: learner.createdAt, last_seen_at: learner.lastSeenAt };
      const inserted = rows(await db.from("learners").insertIfAbsent(row, { onConflict: "token_hash" }).select(learnerColumns));
      if (inserted.length) return learnerOut(inserted[0]);
      const existing = rows(await db.from("learners").select(learnerColumns).eq("token_hash", learner.tokenHash).limit(1));
      if (!existing.length) fail();
      return learnerOut(existing[0]);
    },

    async findLearnerByTokenHash(tokenHash) {
      const found = rows(await db.from("learners").select(learnerColumns).eq("token_hash", tokenHash).limit(1));
      return found.length ? learnerOut(found[0]) : null;
    },

    async touchLearner(id, lastSeenAt) {
      const updated = rows(await db.from("learners").update({ last_seen_at: lastSeenAt }).eq("id", id).select(learnerColumns));
      return updated.length ? learnerOut(updated[0]) : null;
    },

    async insertAttemptIfAbsent(attempt) {
      const row = {
        id: attempt.id,
        learner_id: attempt.learnerId,
        task_id: attempt.taskId,
        step_id: attempt.stepId,
        task_version: attempt.taskVersion,
        command_sha256: attempt.commandSha256,
        output_sha256: attempt.outputSha256,
        status: attempt.status,
        evidence_matched: attempt.evidenceMatched,
        duration_ms: attempt.durationMs,
        created_at: attempt.createdAt
      };
      const inserted = rows(await db.from("attempts").insertIfAbsent(row, { onConflict: "id" }).select(attemptColumns));
      if (inserted.length) return { inserted: true, attempt: attemptOut(inserted[0]) };
      const existing = rows(await db.from("attempts").select(attemptColumns).eq("id", attempt.id).limit(1));
      if (!existing.length) fail();
      return { inserted: false, attempt: attemptOut(existing[0]) };
    },

    async listAttempts(learnerId, limit = 500) {
      return rows(await db.from("attempts").select("id,task_id,step_id,created_at").eq("learner_id", learnerId).order("created_at", { ascending: true }).limit(limit))
        .map((row) => ({ id: row.id, taskId: row.task_id, stepId: row.step_id, createdAt: row.created_at }));
    },

    async markStepComplete({ learnerId, taskId, stepId, taskVersion, completedAt }) {
      const updated = rows(await db.from("step_progress").update({ last_completed_at: completedAt }).eq("learner_id", learnerId).eq("task_version", taskVersion).eq("task_id", taskId).eq("step_id", stepId).select(progressColumns));
      if (updated.length) return progressOut(updated[0]);
      const row = { learner_id: learnerId, task_id: taskId, step_id: stepId, task_version: taskVersion, status: "completed", first_completed_at: completedAt, last_completed_at: completedAt };
      const inserted = rows(await db.from("step_progress").insertIfAbsent(row, { onConflict: "learner_id,task_version,task_id,step_id" }).select(progressColumns));
      if (inserted.length) return progressOut(inserted[0]);
      const existing = rows(await db.from("step_progress").select(progressColumns).eq("learner_id", learnerId).eq("task_version", taskVersion).eq("task_id", taskId).eq("step_id", stepId).limit(1));
      if (!existing.length) fail();
      return progressOut(existing[0]);
    },

    async listProgress(learnerId, taskVersion) {
      return rows(await db.from("step_progress").select(progressColumns).eq("learner_id", learnerId).eq("task_version", taskVersion).order("task_id", { ascending: true }).order("step_id", { ascending: true }).limit(100)).map(progressOut);
    },

    async resetProgress(learnerId) {
      rows(await db.from("learners").delete().eq("id", learnerId));
    }
  };
}
