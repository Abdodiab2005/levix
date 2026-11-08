import { createRequire } from "node:module";
import { Router } from "express";
import * as manage from "../automation/manage.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const router = Router();
export const setSession = manage.setSession;

function route(handler, status = 200) {
  return (req, res) => {
    try {
      res.status(status).json({ success: true, ...handler(req) });
    } catch (error) {
      if (error instanceof manage.ReactionManageError) {
        return res.status(error.status).json({
          success: false,
          error: error.code,
          ...(error.issues ? { issues: error.issues } : {}),
        });
      }
      logger.error({ err: error }, "[Reactions] management failed");
      res.status(500).json({ success: false, error: "INTERNAL" });
    }
  };
}

router.get("/reactions", route(() => manage.overview()));
router.post("/reactions/rules/check", route((req) => manage.checkDraft(req.body)));
router.post("/reactions/rules", route((req) => ({ rule: manage.createRule(req.body) }), 201));
router.put(
  "/reactions/rules/:id",
  route((req) => ({ rule: manage.updateRule(req.params.id, req.body) })),
);
router.post(
  "/reactions/rules/:id/enabled",
  route((req) => ({ rule: manage.setRuleEnabled(req.params.id, req.body) })),
);
router.delete(
  "/reactions/rules/:id",
  route((req) => {
    manage.deleteRule(req.params.id, req.query.revision);
    return {};
  }),
);
router.put(
  "/reactions/automation",
  route((req) => ({ automation: manage.setAutomation(req.body) })),
);

export default router;
