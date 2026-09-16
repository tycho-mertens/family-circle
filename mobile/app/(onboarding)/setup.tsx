import { AppearanceSettings } from "../../src/components/AppearanceSettings";
import { SectionHeading } from "../../src/components/SectionHeading";
import { ServerAccess } from "../../src/components/ServerAccess";
import { Disclosure } from "../../src/components/Disclosure";
import { useState } from "react";
import { Text, View } from "react-native";
import { useIdentity } from "../../src/state/identity";
import { useTheme } from "../../src/theme";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { PageHeading } from "../../src/components/PageHeading";
import { Card } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { Notice } from "../../src/components/Notice";

export default function Setup() {
  const [restoring, setRestoring] = useState(false);
  const [phrase, setPhrase] = useState("");
  const { createNewIdentity, restoreFromSeedPhrase, setupBusy, setupError } = useIdentity();
  const { colors, spacing, type } = useTheme();
  return (
    <ScreenContainer>
      <PageHeading
        eyebrow="Welcome to Family Circle"
        title={restoring ? "Welcome back." : "Good to have you here."}
        body={
          restoring
            ? "Use your saved recovery phrase to bring your identity and backed-up Circles to this phone."
            : "Start with your own private identity. Then create a Circle or accept an invitation."
        }
      />
      <AppearanceSettings />
      <Card>
        <Disclosure title="Server access" summary="For servers that require an access code">
          <ServerAccess />
        </Disclosure>
      </Card>
      <Card>
        <SectionHeading
          title={restoring ? "Restore your identity" : "A fresh start"}
          icon={restoring ? "key-outline" : "person-add-outline"}
        />
        {restoring ? (
          <TextField
            label="Your recovery phrase"
            placeholder="Enter your 12 words, separated by spaces"
            value={phrase}
            onChangeText={setPhrase}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            multiline
            style={{ minHeight: 130, textAlignVertical: "top" }}
          />
        ) : (
          <Text style={[type.body, { color: colors.textSecondary }]}>
            We'll give you a unique 12-word recovery phrase. Save it before continuing — it's your
            way back if you change phones.
          </Text>
        )}
        <View style={{ marginTop: spacing.sm }}>
          <Button
            fullWidth
            title={restoring ? "Restore my identity" : "Create my identity"}
            loading={setupBusy}
            disabled={restoring && !phrase.trim()}
            onPress={async () => {
              if (restoring) {
                if (await restoreFromSeedPhrase(phrase)) setPhrase("");
              } else await createNewIdentity();
            }}
          />
        </View>
      </Card>
      <Notice text={setupError} />
      <Button
        title={restoring ? "I'm new — start fresh" : "Already have a recovery phrase?"}
        variant="ghost"
        disabled={setupBusy}
        onPress={() => setRestoring(!restoring)}
      />
      <Text style={[type.caption, { color: colors.textSecondary }]}>
        An internet connection to your Circle's server is needed for setup and recovery. Restoring a
        backup doesn't restore chat history.
      </Text>
    </ScreenContainer>
  );
}
