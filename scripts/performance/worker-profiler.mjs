/** CDP is diagnostic-only and never enters product Worker code. Attach before
 * execution so boot profiles include module loading and firmware validation. */
export class WorkerProfiler {
  constructor(session, intervalUs) {
    this.session = session;
    this.intervalUs = intervalUs;
    this.next = 1;
    this.pending = new Map();
    this.active = false;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Keep a failure handled until the runner explicitly awaits it after load.
    this.ready.catch(() => {});
    session.on('Target.receivedMessageFromTarget', (event) => {
      if (event.sessionId !== this.workerSession) return;
      const message = JSON.parse(event.message),
        pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    session.on('Target.detachedFromTarget', (event) => {
      if (event.sessionId !== this.workerSession) return;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(Error('Profiled Worker detached'));
      }
      this.pending.clear();
    });
    session.on('Target.attachedToTarget', (event) => {
      this.attach(event).catch((error) => this.rejectReady(error));
    });
  }
  async arm() {
    await this.session.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
    });
  }
  async attach(event) {
    if (event.targetInfo.type !== 'worker') return;
    if (this.workerSession) throw Error('Expected exactly one firmware Worker');
    this.workerSession = event.sessionId;
    this.target = event.targetInfo;
    if (!event.waitingForDebugger)
      throw Error('Worker ran before profiler attachment');
    await this.send('Profiler.enable');
    await this.send('Profiler.setSamplingInterval', {
      interval: this.intervalUs,
    });
    await this.start('boot');
    await this.send('Runtime.runIfWaitingForDebugger');
    this.resolveReady();
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.session
        .send('Target.sendMessageToTarget', {
          sessionId: this.workerSession,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        });
    });
  }
  async start(phase) {
    if (this.active) throw Error('CPU profile already active');
    this.phase = phase;
    await this.send('Profiler.start');
    this.active = true;
  }
  async stop() {
    if (!this.active) throw Error('No active CPU profile');
    const { profile } = await this.send('Profiler.stop');
    this.active = false;
    return profile;
  }
  async close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error('Profiler closed'));
    }
    this.pending.clear();
    await this.session.detach().catch(() => {});
  }
}
