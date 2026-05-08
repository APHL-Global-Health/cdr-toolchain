import type { IncomingMessage, ServerResponse } from "node:http";

export const colours = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  underscore: "\x1b[4m",
  blink: "\x1b[5m",
  reverse: "\x1b[7m",
  hidden: "\x1b[8m",

  fg: {
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    crimson: "\x1b[38m",
  },
  bg: {
    black: "\x1b[40m",
    red: "\x1b[41m",
    green: "\x1b[42m",
    yellow: "\x1b[43m",
    blue: "\x1b[44m",
    magenta: "\x1b[45m",
    cyan: "\x1b[46m",
    white: "\x1b[47m",
    crimson: "\x1b[48m",
  },
} as const;

export function console_color(color: string, msg: string, reset: string): string {
  return `${color}${msg}${reset}`;
}

export function get_timestamp(): string {
  const date_ob = new Date();
  const date = ("0" + date_ob.getDate()).slice(-2);
  const month = ("0" + (date_ob.getMonth() + 1)).slice(-2);
  const year = date_ob.getFullYear();
  const hours = ("0" + date_ob.getHours()).slice(-2);
  const minutes = ("0" + date_ob.getMinutes()).slice(-2);
  const seconds = ("0" + date_ob.getSeconds()).slice(-2);

  return `${year}-${month}-${date} ${hours}:${minutes}:${seconds}`;
}

async function sleep_and_print(time: number, msg: string): Promise<void> {
  await new Promise((r) => setTimeout(r, time));
  console.log(msg);
}

export function print_error(owner: string, tag: string, msg: string): void {
  const timestamp = get_timestamp();
  let console_text = console_color("\x1b[37m", `[`, "\x1b[0m");
  console_text += console_color("\x1b[32m", owner.toUpperCase(), "\x1b[0m");
  console_text += console_color("\x1b[37m", `] `, "\x1b[0m");
  console_text += console_color("\x1b[36m", `${timestamp} `, "\x1b[0m");
  console_text += console_color("\x1b[33m", `${tag.toUpperCase()} `, "\x1b[0m");
  console_text += console_color("\x1b[37m", `${msg} `, "\x1b[0m");
  console_text += console_color("\x1b[31m", `Error`, "\x1b[0m");
  console.log(console_text);
}

export function print_log(owner: string, tag: string, msg: string, status: string): void {
  const timestamp = get_timestamp();
  let console_text = console_color("\x1b[37m", `[`, "\x1b[0m");
  console_text += console_color("\x1b[32m", owner.toUpperCase(), "\x1b[0m");
  console_text += console_color("\x1b[37m", `] `, "\x1b[0m");
  console_text += console_color("\x1b[36m", `${timestamp} `, "\x1b[0m");
  console_text += console_color("\x1b[33m", `${tag.toUpperCase()} `, "\x1b[0m");
  console_text += console_color("\x1b[37m", `${msg} `, "\x1b[0m");
  console_text += console_color("\x1b[32m", status, "\x1b[0m");
  console.log(console_text);
}

interface MinimalExpressLikeApp {
  use: (
    handler: (req: IncomingMessage & Record<string, unknown>, res: ServerResponse, next: () => void) => void,
  ) => void;
}

export function use(app: MinimalExpressLikeApp, tag: string): void {
  const sleep_time = 5;

  app.use((req, res, next) => {
    res.on("finish", () => {
      const timestamp = get_timestamp();

      const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
      const xRealIp = headers["x-real-ip"] as string | undefined;
      const xForwardedFor = (headers["x-forwarded-for"] as string | undefined) ?? "";
      const socketAddr = (req as unknown as { socket?: { remoteAddress?: string } }).socket?.remoteAddress ?? "";
      const connectionAddr = (req as unknown as { connection?: { remoteAddress?: string } }).connection?.remoteAddress ?? "";

      const ip =
        xRealIp ??
        xForwardedFor.split(",")[0] ??
        socketAddr.split(":").pop() ??
        connectionAddr.split(":").pop();

      const method = (req as unknown as { method?: string }).method ?? "";
      const protocol = (req as unknown as { protocol?: string }).protocol ?? "";
      const host = (req as unknown as { get?: (h: string) => string }).get?.("host") ?? "";
      const url = (req as unknown as { originalUrl?: string }).originalUrl ?? "";
      const statusCode = res.statusCode;

      let console_text = console_color(colours.fg.white, `[`, colours.reset);
      console_text += console_color(colours.fg.green, tag, colours.reset);
      console_text += console_color(colours.fg.white, `] `, colours.reset);
      console_text += console_color(colours.fg.cyan, `${timestamp} `, colours.reset);
      console_text += console_color(colours.fg.yellow, `${method} `, colours.reset);
      console_text += console_color(colours.fg.green, `${ip} `, colours.reset);
      console_text += console_color(colours.fg.white, `${protocol}://${host}${url} `, colours.reset);
      console_text += console_color(
        statusCode === 200 ? colours.fg.green : colours.fg.red,
        `${statusCode} `,
        colours.reset,
      );

      void sleep_and_print(sleep_time, console_text);

      const body = (req as unknown as { _body?: boolean; body?: unknown })._body;
      if (body === true) {
        const bodyJson = JSON.stringify((req as unknown as { body?: unknown }).body);
        console_text = console_color(colours.fg.white, `[`, colours.reset);
        console_text += console_color(colours.fg.green, tag, colours.reset);
        console_text += console_color(colours.fg.white, `] `, colours.reset);
        console_text += console_color(colours.fg.cyan, `${timestamp} `, colours.reset);
        console_text += console_color(colours.fg.yellow, `BODY `, colours.reset);
        console_text += console_color(colours.fg.green, `${ip} `, colours.reset);
        console_text += console_color(colours.fg.white, `${bodyJson} `, colours.reset);
        void sleep_and_print(sleep_time, console_text);
      }
    });
    next();
  });
}
