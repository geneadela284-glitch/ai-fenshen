const SAFE_TASKS_ERROR = '事项暂时无法读取，请稍后重试。';

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || SAFE_TASKS_ERROR);
    error.code = payload.code || (response.status === 401 ? 'AUTH_REQUIRED' : 'TASKS_UNAVAILABLE');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function taskId(value) {
  const id = String(value || '').trim();
  if (!id) throw Object.assign(new Error('事项标识无效。'), { code: 'TASK_ID_INVALID' });
  return encodeURIComponent(id);
}

export function createTasksClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Tasks fetch implementation is required.');

  const taskAction = async (id, action) => {
    const payload = await readJson(await fetchImpl(`/api/tasks/${taskId(id)}/${action}`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' }
    }));
    return payload.task;
  };

  return {
    async getTodayTomorrow({ timezone, signal } = {}) {
      const zone = String(timezone || '').trim();
      if (!zone) throw Object.assign(new Error('用户时区无效。'), { code: 'TASK_TIMEZONE_INVALID' });
      const payload = await readJson(await fetchImpl(
        `/api/tasks/today-tomorrow?timezone=${encodeURIComponent(zone)}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
          ...(signal ? { signal } : {})
        }
      ));
      return {
        state: payload.state,
        today: Array.isArray(payload.today) ? payload.today : [],
        tomorrow: Array.isArray(payload.tomorrow) ? payload.tomorrow : [],
        range: payload.range || { timezone: zone }
      };
    },
    complete(id) {
      return taskAction(id, 'complete');
    },
    restore(id) {
      return taskAction(id, 'restore');
    }
  };
}

export { SAFE_TASKS_ERROR };
