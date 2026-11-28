export function createTaskQueue() {
  let tail = Promise.resolve();
  return {
    run(operation) {
      const result = tail.then(operation, operation);
      tail = result.catch(() => {});
      return result;
    }
  };
}
