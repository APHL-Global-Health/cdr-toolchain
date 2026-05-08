import { Router } from "express";
import { VERSION } from "disalab";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), disalab: VERSION });
});
