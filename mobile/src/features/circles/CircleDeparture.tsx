import { canTransferAdmin, departureAction } from "../../runtime/circle-lifecycle";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Text } from "react-native";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Notice } from "../../components/Notice";
import { SectionHeading } from "../../components/SectionHeading";
import { useCircles } from "../../state/circles";
import { useIdentity } from "../../state/identity";
import { useTheme } from "../../theme";

import type { CircleInfo } from "../../runtime/circle-types";
interface Props {
  circle: CircleInfo;
  busy: string | null;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
  admin: boolean;
}

export function CircleDeparture({ circle, busy, run, admin }: Props) {
  const state = useCircles();
  const { deviceId, nicknames } = useIdentity();
  const { colors, type } = useTheme();
  const { circleId } = circle;
  const [successor, setSuccessor] = useState<string | null>(null);
  return (
    <Card style={{ borderColor: colors.danger + "40" }}>
      <SectionHeading title="Leave this Circle" icon="exit-outline" />
      <Text style={[type.body, { color: colors.textSecondary }]}>
        Your departure stays pending until a membership update confirms removal. You'll need a
        new invitation to return.
      </Text>
      {admin && circle.members.length > 1 && (
        <>
          <Text style={[type.body, { color: colors.textSecondary }]}>
            Choose who will manage invitations and membership after you. Their phone must
            confirm the handover before you leave.
          </Text>
          {circle.members
            .filter((id) => id !== deviceId && !circle.departingMembers?.includes(id))
            .map((id) => (
              <Button
                key={id}
                title={`${successor === id ? "✓ " : ""}${nicknames[id] ?? id.slice(0, 12)}`}
                variant={successor === id ? "secondary" : "ghost"}
                disabled={!!busy || (!!circle.handover && !circle.handover.confirmed)}
                onPress={() => setSuccessor(id)}
              />
            ))}
          <Button
            title="Make selected member admin"
            variant="secondary"
            disabled={!!busy || !successor || !canTransferAdmin(circle)}
            loading={busy === "handover"}
            onPress={() =>
              Alert.alert(
                "Transfer admin role?",
                "The selected member will manage this Circle. You will remain a member until you choose to leave.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Transfer",
                    onPress: () =>
                      run("handover", () => state.transferAdmin(circleId, successor!)),
                  },
                ],
              )
            }
          />
        </>
      )}
      {circle.handover && (
        <Notice
          text={
            circle.handover.confirmed
              ? `${nicknames[circle.handover.adminId] ?? "The new admin"} has received the handover. You can leave now.`
              : "Handover pending. Waiting for the new admin's phone to reconnect and confirm."
          }
        />
      )}
      <Button
        title="Leave Circle"
        variant="danger"
        disabled={!!busy || departureAction(circle) === "handover"}
        loading={busy === "leave"}
        onPress={() =>
          Alert.alert(
            "Ready to leave?",
            "Leave this Circle and delete its chat history from this phone? Your departure will remain visible until confirmed.",
            [
              { text: "Stay", style: "cancel" },
              {
                text: "Leave Circle",
                style: "destructive",
                onPress: () =>
                  run("leave", async () => {
                    if (await state.leaveCircle(circleId)) router.replace("/(app)");
                  }),
              },
            ],
          )
        }
      />
    </Card>
  );
}
