import { Card } from "../../src/components/Card";
import { useState } from "react";
import { useIdentity, MAX_NICKNAME_LEN } from "../../src/state/identity";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { PageHeading } from "../../src/components/PageHeading";
import { ProfilePhotoEditor } from "../../src/components/ProfilePhotoEditor";
import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";

export default function Nickname() {
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const { finishNickname } = useIdentity();
  return (
    <ScreenContainer>
      <PageHeading
        eyebrow="A familiar face"
        title="What should we call you?"
        body="Choose a name and an optional photo your people will recognize. It will appear in every Circle you join, and you can change it in Profile anytime."
      />
      <Card>
        <ProfilePhotoEditor
          name={name}
          photo={photo}
          onBusyChange={setPhotoBusy}
          onChange={(value) => {
            setPhoto(value);
            return true;
          }}
        />
        <TextField
          label="Your nickname"
          placeholder="e.g. Alex"
          value={name}
          onChangeText={setName}
          maxLength={MAX_NICKNAME_LEN}
          autoCapitalize="words"
          onSubmitEditing={() => {
            if (!photoBusy && name.trim()) finishNickname(name, photo);
          }}
        />
      </Card>
      <Button
        title="Continue"
        fullWidth
        disabled={!name.trim() || photoBusy}
        onPress={() => finishNickname(name, photo)}
      />
      <Button
        title="Skip for now"
        variant="ghost"
        disabled={photoBusy}
        onPress={() => finishNickname(undefined, photo)}
      />
    </ScreenContainer>
  );
}
