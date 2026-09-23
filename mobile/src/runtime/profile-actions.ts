import { validProfilePhoto } from "../profile-photo";
import { MAX_CIRCLE_NAME_LEN } from "./circle-constants";
import { MAX_NICKNAME_LEN } from "./identity-constants";
import type { IdentityContextValue } from "./identity";
import {
  circleLabel,
  displayMember,
  shortId,
  type AppPayload,
  type CircleInfo,
} from "./circle-types";

interface Dependencies {
  getCircle: (id: string) => CircleInfo | undefined;
  listCircles: () => CircleInfo[];
  patchCircle: (id: string, patch: Partial<CircleInfo>) => void;
  getIdentity: () => Pick<
    IdentityContextValue,
    "deviceId" | "nicknames" | "profilePhotos"
  >;
  updateNicknames: IdentityContextValue["updateNicknames"];
  updateProfilePhotos: IdentityContextValue["updateProfilePhotos"];
  refreshMembers: (id: string) => Promise<string[] | null>;
  notifyIfBackgrounded: (id: string, title: string, body: string) => void;
  appendSystem: (id: string, text: string) => void;
  scheduleBackup: () => void;
}

export function createProfileActions({
  getCircle,
  listCircles,
  patchCircle,
  getIdentity,
  updateNicknames,
  updateProfilePhotos,
  refreshMembers,
  notifyIfBackgrounded,
  appendSystem,
  scheduleBackup,
}: Dependencies) {
  // Save profile broadcasts with other pending application payloads. They
  // wait for catch-up and any staged membership publication before encryption.
  const broadcastToCircle = async (circleId: string, payload: AppPayload) => {
    const circle = getCircle(circleId);
    if (!circle || circle.deleting || circle.role !== "member") return;
    if (
      (circle.recoveryRequired || circle.syncError) &&
      payload.type !== "receipt" &&
      payload.type !== "admin-ack"
    )
      return;
    patchCircle(circleId, {
      pendingBroadcasts: [...(circle.pendingBroadcasts ?? []), JSON.stringify(payload)],
    });
  };

  const broadcastNicknameToAllCircles = async (nickname: string) => {
    for (const circle of listCircles()) {
      await broadcastToCircle(circle.circleId, { type: "nickname", nickname });
    }
  };

  // New members cannot decrypt earlier messages. Re-broadcast our profile
  // and, for the admin, Circle metadata before notifying about the join.
  const notifyNewMembers = async (circleId: string, previousMembers: string[]) => {
    const after = await refreshMembers(circleId);
    if (!after) return;
    const newcomers = after.filter((id) => !previousMembers.includes(id));
    if (newcomers.length === 0) return;

    const current = getCircle(circleId);
    const me = getIdentity().deviceId;
    const myNickname = me ? getIdentity().nicknames[me] : undefined;
    if (myNickname) {
      await broadcastToCircle(circleId, { type: "nickname", nickname: myNickname });
    }
    if (me)
      await broadcastToCircle(circleId, {
        type: "profile-photo",
        photo: getIdentity().profilePhotos[me] ?? null,
      });
    if (current?.isAdmin)
      await broadcastToCircle(circleId, { type: "circle-admin", adminId: me! });
    if (current?.isAdmin && current.circleName) {
      await broadcastToCircle(circleId, {
        type: "circle-rename",
        name: current.circleName,
      });
    }

    notifyIfBackgrounded(
      circleId,
      `New member in ${current ? circleLabel(current) : shortId(circleId)}`,
      newcomers.length === 1
        ? `${displayMember(newcomers[0], getIdentity().nicknames)} joined`
        : `${newcomers.length} new members joined`,
    );
  };

  const setNickname = async (nickname: string) => {
    const me = getIdentity().deviceId;
    const trimmed = nickname.trim().slice(0, MAX_NICKNAME_LEN);
    if (!me || !trimmed || trimmed === getIdentity().nicknames[me]) return;
    updateNicknames((prev) => ({ ...prev, [me]: trimmed }));
    await broadcastNicknameToAllCircles(trimmed);
    scheduleBackup();
  };

  const setProfilePhoto = async (photo: string | null): Promise<boolean> => {
    const me = getIdentity().deviceId;
    if (!me || !validProfilePhoto(photo)) return false;
    if ((getIdentity().profilePhotos[me] ?? null) === photo) return true;
    updateProfilePhotos((prev) => ({ ...prev, [me]: photo }));
    for (const circle of listCircles()) {
      await broadcastToCircle(circle.circleId, { type: "profile-photo", photo });
    }
    scheduleBackup();
    return true;
  };

  // Local callers must be the admin. Receiving clients still need their
  // own sender check to reject renames from a modified member client.
  const setCircleName = async (circleId: string, name: string) => {
    const active = getCircle(circleId);
    const trimmed = name.trim().slice(0, MAX_CIRCLE_NAME_LEN);
    if (
      !active?.isAdmin ||
      active.deleting ||
      !trimmed ||
      trimmed === active.circleName
    )
      return;
    patchCircle(circleId, { circleName: trimmed });
    await broadcastToCircle(circleId, { type: "circle-rename", name: trimmed });
    appendSystem(circleId, `Circle renamed to "${trimmed}"`);
    scheduleBackup();
  };

  return {
    broadcastToCircle,
    notifyNewMembers,
    setNickname,
    setProfilePhoto,
    setCircleName,
  };
}
