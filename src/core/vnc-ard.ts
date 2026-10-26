// macOS 屏幕共享的苹果认证（Apple Remote Desktop，RFB 安全类型 30）：用 Mac 的用户名和登录密码登录。
// 屏幕共享没开「VNC 显示程序可以使用密码控制屏幕」时，它只给苹果自己的几种认证，普通 VNC 密码那种没有。
//
// 认证在服务端做完，再对页面（noVNC）装成一个不用认证的 VNC 服务：
//   - 登录密码不用发到浏览器；
//   - noVNC 自己做这种认证要用 crypto.subtle，只有 https / localhost 下才有，用 http://IP 访问时用不了。
//
// 协议：服务端给 DH 的生成元、素数和它的公钥；双方算出共享密钥，MD5 一下当 AES-128 的钥匙，
// 把「用户名 \0 … | 密码 \0 …」各 64 字节（空的地方填随机数）用 AES-ECB 加密，连同自己的公钥发回去。
import crypto from "node:crypto";

/** 按需读字节：数据一段段进来（TCP 的 data、WebSocket 的 message），要多少等多少 */
export class ByteReader {
  private buf = Buffer.alloc(0);
  private waiting: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private error: Error | null = null;

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.flush();
  }

  /** 那头断了：在等的和以后要读的都报这个错 */
  fail(err: Error): void {
    this.error ??= err;
    const w = this.waiting;
    this.waiting = null;
    w?.reject(this.error);
  }

  read(n: number): Promise<Buffer> {
    if (this.waiting) return Promise.reject(new Error("上一次读还没完"));
    return new Promise((resolve, reject) => {
      this.waiting = { n, resolve, reject };
      this.flush();
      if (this.waiting && this.error) this.fail(this.error);
    });
  }

  /** 握手完了：多读进来的那点交给后面原样转发 */
  rest(): Buffer {
    const b = this.buf;
    this.buf = Buffer.alloc(0);
    return b;
  }

  private flush(): void {
    const w = this.waiting;
    if (!w || this.buf.length < w.n) return;
    this.waiting = null;
    const out = this.buf.subarray(0, w.n);
    this.buf = this.buf.subarray(w.n);
    w.resolve(Buffer.from(out));
  }
}

/** 认证没过（用户名密码不对、服务不支持）：message 原样给页面看 */
export class VncAuthError extends Error {}

const TYPE_ARD = 30;

/** 左边补 0 到 len 字节（DH 的数可能比素数短） */
function pad(b: Buffer, len: number): Buffer {
  return b.length >= len ? b.subarray(b.length - len) : Buffer.concat([Buffer.alloc(len - b.length), b]);
}

/** 按苹果认证算出要发回去的：加密后的 128 字节凭据 + 自己的公钥 */
export function ardResponse(generator: Buffer, prime: Buffer, serverKey: Buffer, username: string, password: string): Buffer {
  const dh = crypto.createDiffieHellman(prime, generator);
  const publicKey = pad(dh.generateKeys(), prime.length);
  const shared = pad(dh.computeSecret(serverKey), prime.length);
  const creds = crypto.randomBytes(128);
  // 各最多 63 字节，后面跟一个 \0（和 noVNC、苹果自己的客户端一样）
  const user = Buffer.from(username, "utf8").subarray(0, 63);
  const pass = Buffer.from(password, "utf8").subarray(0, 63);
  user.copy(creds, 0);
  creds[user.length] = 0;
  pass.copy(creds, 64);
  creds[64 + pass.length] = 0;
  const cipher = crypto.createCipheriv("aes-128-ecb", crypto.createHash("md5").update(shared).digest(), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(creds), cipher.final(), publicKey]);
}

/**
 * 作为客户端和 VNC 服务走完版本协商和苹果认证，停在 ClientInit 之前（后面原样转发就行）。
 * 失败抛 VncAuthError（认证的问题）或普通 Error（连接断了）
 */
export async function ardLogin(r: ByteReader, write: (b: Buffer) => void, username: string, password: string): Promise<void> {
  const version = (await r.read(12)).toString("latin1");
  if (!/^RFB \d{3}\.\d{3}\n$/.test(version)) throw new VncAuthError("对方不是 VNC 服务");
  // 苹果的是 003.889，按 3.8 谈就行
  write(Buffer.from("RFB 003.008\n", "latin1"));
  const count = (await r.read(1))[0]!;
  if (count === 0) {
    const len = (await r.read(4)).readUInt32BE(0);
    throw new VncAuthError(`VNC 服务拒绝连接：${(await r.read(len)).toString("utf8")}`);
  }
  const types = [...(await r.read(count))];
  if (!types.includes(TYPE_ARD)) throw new VncAuthError("这个 VNC 服务不支持用 Mac 用户名登录：把设置里的用户名留空，只填 VNC 密码");
  write(Buffer.from([TYPE_ARD]));
  const head = await r.read(4);
  const generator = head.subarray(0, 2);
  const keyLength = head.readUInt16BE(2);
  const prime = await r.read(keyLength);
  const serverKey = await r.read(keyLength);
  write(ardResponse(generator, prime, serverKey, username, password));
  const status = (await r.read(4)).readUInt32BE(0);
  if (status !== 0) throw new VncAuthError("Mac 的用户名或密码不对");
}

/**
 * 对页面那头装成不用认证的 VNC 服务（3.8，只给安全类型 None）。
 * login 是和真正的 VNC 服务认证的过程：它失败时把原因当作认证失败告诉页面
 */
export async function serveNoAuth(r: ByteReader, write: (b: Buffer) => void, login: Promise<void>): Promise<void> {
  // 页面那头还没谈完 login 就失败了：先接住，下面 await 时再处理（不然算没人接的 rejection，进程会退出）
  login.catch(() => {});
  write(Buffer.from("RFB 003.008\n", "latin1"));
  await r.read(12);
  write(Buffer.from([1, 1]));
  await r.read(1);
  try {
    await login;
  } catch (err) {
    const reason = Buffer.from(err instanceof VncAuthError ? err.message : `连不上 VNC 服务：${err instanceof Error ? err.message : err}`, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(reason.length);
    write(Buffer.concat([Buffer.from([0, 0, 0, 1]), len, reason]));
    throw err;
  }
  write(Buffer.from([0, 0, 0, 0]));
}
