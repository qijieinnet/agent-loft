// 事件去重。IM 平台对消息和回调都可能重投，不挡住就会重复执行：
// 消息重投 = 同一句话跑两遍；回调重投 = 第一次消费掉待处理项，第二次误报「已失效」。
export class Dedup {
  private seen = new Set<string>();
  constructor(private readonly max = 2000) {}

  isDuplicate(id: string | undefined): boolean {
    if (!id) return false;
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    if (this.seen.size > this.max) {
      for (const key of [...this.seen].slice(0, this.max / 2)) this.seen.delete(key);
    }
    return false;
  }
}
