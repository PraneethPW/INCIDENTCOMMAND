import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { requirePool, transaction } from "./database.js";
import { createSessionToken, setSessionCookie } from "./auth.js";
import { requireAdmin, requireOperator, httpError } from "./security.js";
import { broadcast } from "./realtime.js";

export const workspace = Router();
workspace.get("/workspaces", async (req, res) => {
  const result = await requirePool().query(
    `SELECT o.id,o.name,m.role FROM organizations o JOIN memberships m ON o.id=m.organization_id WHERE m.user_id=$1 ORDER BY o.name`,
    [req.user!.userId],
  );
  res.json({ data: result.rows });
});
workspace.post("/workspaces/switch", async (req, res) => {
  const { organizationId } = z
    .object({ organizationId: z.string().uuid() })
    .parse(req.body);
  const membership = await requirePool().query(
    "SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2",
    [organizationId, req.user!.userId],
  );
  if (!membership.rowCount) throw httpError(404, "Workspace not found");
  setSessionCookie(
    res,
    await createSessionToken(req.user!.userId, organizationId),
  );
  res.json({ ok: true });
});
workspace.get("/team", async (req, res) => {
  const result = await requirePool().query(
    `SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY u.name`,
    [req.user!.organizationId],
  );
  res.json({ data: result.rows });
});
workspace.post("/team/invites", requireAdmin, async (req, res) => {
  const { role } = z
    .object({
      role: z.enum(["responder", "viewer", "admin"]).default("responder"),
    })
    .parse(req.body);
  if (role === "admin" && req.user!.role !== "owner")
    throw httpError(403, "Only the owner can invite administrators");
  const token = randomBytes(24).toString("hex");
  await requirePool().query(
    "INSERT INTO workspace_invites(token_hash,organization_id,role) VALUES($1,$2,$3)",
    [
      createHash("sha256").update(token).digest("hex"),
      req.user!.organizationId,
      role,
    ],
  );
  res.status(201).json({ data: { token, expiresInHours: 48 } });
});
workspace.post("/team/join", async (req, res) => {
  const { token } = z
    .object({ token: z.string().regex(/^[a-f0-9]{48}$/) })
    .parse(req.body);
  const organizationId = await transaction(async (db) => {
    const result = await db.query(
      `SELECT organization_id,role FROM workspace_invites WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() FOR UPDATE`,
      [createHash("sha256").update(token).digest("hex")],
    );
    if (!result.rowCount)
      throw httpError(400, "Invitation is expired or already used");
    const invite = result.rows[0];
    await db.query(
      "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [invite.organization_id, req.user!.userId, invite.role],
    );
    await db.query(
      "UPDATE workspace_invites SET used_at=NOW() WHERE token_hash=$1",
      [createHash("sha256").update(token).digest("hex")],
    );
    return invite.organization_id as string;
  });
  setSessionCookie(
    res,
    await createSessionToken(req.user!.userId, organizationId),
  );
  broadcast(organizationId, {
    type: "team.updated",
    message: `${req.user!.name} joined the workspace`,
  });
  res.json({ ok: true });
});
workspace.patch("/team/:id", requireAdmin, async (req, res) => {
  const { role } = z
    .object({ role: z.enum(["admin", "responder", "viewer"]) })
    .parse(req.body);
  if (req.user!.role !== "owner")
    throw httpError(403, "Only the owner can change roles");
  const result = await requirePool().query(
    `UPDATE memberships SET role=$1 WHERE organization_id=$2 AND user_id=$3 AND role<>'owner' RETURNING user_id`,
    [role, req.user!.organizationId, req.params.id],
  );
  if (!result.rowCount)
    throw httpError(404, "Member not found or owner is protected");
  broadcast(req.user!.organizationId, {
    type: "team.updated",
    message: "Workspace permissions updated",
  });
  res.json({ ok: true });
});
workspace.post("/incidents/:id/notes", requireOperator, async (req, res) => {
  const { message } = z
    .object({ message: z.string().trim().min(1).max(2000) })
    .parse(req.body);
  const org = req.user!.organizationId;
  const result = await requirePool().query(
    `INSERT INTO incident_events(organization_id,incident_id,actor_user_id,event_type,message) SELECT organization_id,id,$3,'note',$4 FROM incidents WHERE organization_id=$1 AND id=$2 RETURNING id`,
    [org, req.params.id, req.user!.userId, message],
  );
  if (!result.rowCount) throw httpError(404, "Incident not found");
  broadcast(org, {
    type: "incident.updated",
    message: "Responder note added",
    resource: "incident",
    resourceId: String(req.params.id),
  });
  res.status(201).json({ ok: true });
});
workspace.patch(
  "/incidents/:id/assignee",
  requireOperator,
  async (req, res) => {
    const { userId } = z
      .object({ userId: z.string().uuid().nullable() })
      .parse(req.body);
    const org = req.user!.organizationId;
    await transaction(async (db) => {
      if (
        userId &&
        !(
          await db.query(
            `SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2 AND role<>'viewer'`,
            [org, userId],
          )
        ).rowCount
      )
        throw httpError(400, "Choose a responder in this workspace");
      const result = await db.query(
        "UPDATE incidents SET assigned_to=$1,updated_at=NOW() WHERE organization_id=$2 AND id=$3 RETURNING id",
        [userId, org, req.params.id],
      );
      if (!result.rowCount) throw httpError(404, "Incident not found");
      await db.query(
        `INSERT INTO incident_events(organization_id,incident_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,$3,'assigned',$4,$5)`,
        [
          org,
          req.params.id,
          req.user!.userId,
          userId ? "Incident owner assigned." : "Incident owner cleared.",
          JSON.stringify({ userId }),
        ],
      );
    });
    broadcast(org, {
      type: "incident.updated",
      message: "Incident ownership updated",
      resource: "incident",
      resourceId: String(req.params.id),
    });
    res.json({ ok: true });
  },
);
