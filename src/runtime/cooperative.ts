/** Bounded synchronous work followed by a task boundary so Worker messages run. */
export class CooperativeRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private channel: MessageChannel | undefined;
  private active = false;
  private generation = 0;
  constructor(
    private step: () => number | void,
    private onError: (error: unknown) => void,
    private budgetMs: number | (() => number) = 8,
  ) {}
  start(): void {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    const channel = new MessageChannel();
    this.channel = channel;
    const turn = () => {
      if (!this.active || generation !== this.generation) return;
      const deadline =
        performance.now() +
        (typeof this.budgetMs === 'number' ? this.budgetMs : this.budgetMs());
      let delay = 0;
      try {
        do {
          const next = this.step();
          if (typeof next === 'number' && next > 0) {
            delay = next;
            break;
          }
        } while (this.active && performance.now() < deadline);
      } catch (error) {
        this.stop();
        this.onError(error);
        return;
      }
      if (this.active) {
        // A MessagePort is a task boundary without the nested-timer 4 ms clamp.
        // Positive delays still pace guest time against the wall clock.
        if (delay > 0) this.timer = setTimeout(turn, delay);
        else channel.port2.postMessage(null);
      }
    };
    channel.port1.onmessage = turn;
    channel.port2.postMessage(null);
  }
  stop(): void {
    this.active = false;
    this.generation++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.channel?.port1.close();
    this.channel?.port2.close();
    this.channel = undefined;
  }
}
