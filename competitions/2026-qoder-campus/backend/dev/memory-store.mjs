export class MemoryStore {
  constructor() {
    this.learners = new Map();
    this.attempts = new Map();
    this.progress = new Map();
  }

  async createLearner(learner) {
    const existing = await this.findLearnerByTokenHash(learner.tokenHash);
    if (existing) return existing;
    this.learners.set(learner.id, { ...learner });
    return { ...learner };
  }

  async findLearnerByTokenHash(tokenHash) {
    for (const learner of this.learners.values()) {
      if (learner.tokenHash === tokenHash) return { ...learner };
    }
    return null;
  }

  async touchLearner(id, lastSeenAt) {
    const learner = this.learners.get(id);
    if (!learner) return null;
    learner.lastSeenAt = lastSeenAt;
    return { ...learner };
  }

  async insertAttemptIfAbsent(attempt) {
    if (!this.learners.has(attempt.learnerId)) throw new Error("foreign_key_violation");
    const existing = this.attempts.get(attempt.id);
    if (existing) return { inserted: false, attempt: { ...existing } };
    this.attempts.set(attempt.id, { ...attempt });
    return { inserted: true, attempt: { ...attempt } };
  }

  async listAttempts(learnerId, limit = 500) {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.learnerId === learnerId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map((attempt) => ({ ...attempt }));
  }

  async markStepComplete({ learnerId, taskId, stepId, taskVersion, completedAt }) {
    if (!this.learners.has(learnerId)) throw new Error("foreign_key_violation");
    const key = `${learnerId}:${taskVersion}:${taskId}:${stepId}`;
    const existing = this.progress.get(key);
    const row = existing
      ? { ...existing, lastCompletedAt: completedAt }
      : { learnerId, taskId, stepId, taskVersion, status: "completed", firstCompletedAt: completedAt, lastCompletedAt: completedAt };
    this.progress.set(key, row);
    return { ...row };
  }

  async listProgress(learnerId, taskVersion) {
    return [...this.progress.values()]
      .filter((row) => row.learnerId === learnerId && row.taskVersion === taskVersion)
      .sort((left, right) => `${left.taskId}:${left.stepId}`.localeCompare(`${right.taskId}:${right.stepId}`))
      .map((row) => ({ ...row }));
  }

  async resetProgress(learnerId) {
    this.learners.delete(learnerId);
    for (const [id, attempt] of this.attempts) {
      if (attempt.learnerId === learnerId) this.attempts.delete(id);
    }
    for (const [key, row] of this.progress) {
      if (row.learnerId === learnerId) this.progress.delete(key);
    }
  }
}
