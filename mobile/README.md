# Family Circle mobile app

This is the Android app, built with React Native, TypeScript, and Expo Router. Its Kotlin bridge handles Android services and storage and calls the Rust core for encryption. It needs a native build; Expo Go cannot run it.

Start with the [root README](../README.md#run-locally) to build the Rust libraries and bindings, prepare map assets, and start the relay and map gateway. This guide covers the mobile code and day-to-day development.

## Running the app

From this folder, after completing the native and service setup:

```bash
npm ci
npm run android
```

`npm run android` and `npm start` detect the machine's LAN address and write the relay and map URLs to `.env`. The phone needs to reach that address. The default ports are `5080` for the relay and `8090` for maps.

For custom addresses, copy [.env.example](.env.example) to `.env`, edit it, and run Expo directly so the LAN detector does not overwrite your values:

```bash
npx expo run:android
# For an already installed development build:
npx expo start --dev-client
```

Android emulators can normally reach the host through `10.0.2.2`. A physical phone needs a reachable LAN address. `EXPO_PUBLIC_*` values are bundled into the app, so keep secrets out of them.

If an HTTP host changes, regenerate the native configuration and rebuild:

```bash
npx expo prebuild --platform android --no-install
npx expo run:android
```

The network-security plugin allows release builds to use HTTP only for the configured private or loopback hosts. Public hosts must use HTTPS. Regenerate the map styles when their public address changes too; the root guide has the command.

## Finding your way around

Routes compose screens. Feature modules hold the chat, map, and circle-management UI. React providers subscribe to a shared runtime, which Android services can wake even when no screen is mounted.

| Location | What lives here |
| --- | --- |
| [app/](app/) | Routes, screen composition, and navigation |
| [src/features/chat/](src/features/chat/) | Composer, replies, message menus, and reaction details |
| [src/features/map/](src/features/map/) | Camera and refresh hooks, markers, pin details, and the draggable people panel |
| [src/features/circles/](src/features/circles/) | Invitations, leaving a circle, and admin handover UI |
| [src/components/](src/components/) | Shared controls and message rendering |
| [src/state/](src/state/) | React providers that subscribe to runtime state |
| [src/runtime/circles.ts](src/runtime/circles.ts) | Runtime initialization and wiring for circle operations |
| [src/backup.ts](src/backup.ts) | Identity recovery, remote backups, and the shared persistence instance |
| [src/persistence/](src/persistence/) | Local checkpoints, metadata, credentials, and the durable outgoing queue |
| [modules/family-circle-bridge/](modules/family-circle-bridge/) | Expo bindings and Android services |
| [tests/](tests/) | Mobile behavior and UI tests |

Within `src/runtime/`, these are useful starting points:

| Files | Responsibility |
| --- | --- |
| `circle-store.ts`, `circle-transitions.ts`, `circle-lifecycle.ts` | Circle state, membership transitions, and the action rules shared by the runtime and UI |
| `circle-checkpoints.ts`, `circle-types.ts` | Saved state, replay tracking, pending joins, and runtime types |
| `circle-sync.ts`, `control-handler.ts`, `application-handler.ts` | Ordered mailbox processing and incoming protocol messages |
| `application-payload.ts` | Checking decrypted JSON before a handler receives it |
| `message-actions.ts`, `timeline.ts` | Drafts, edits, deletion, reactions, attachments, and delivery state |
| `invitation-actions.ts`, `membership-actions.ts`, `membership-publication.ts` | Joining, removal, departure, admin transfer, and publishing membership changes |
| `profile-actions.ts`, `circle-notifications.ts` | Profile changes, circle names, and notifications after a successful save |
| `connection-monitor.ts`, `connection-environment.ts` | Foreground polling, app-state listeners, and their native, network, and timer dependencies |

Runtime handlers receive their dependencies when they are created. Creating a handler does not start timers or network work. The runtime owns those triggers, and overlapping foreground checks share the current pass.

## State and persistence

`circle-store.ts` owns the current circle map. Handlers read the latest state through accessors, so they see restored data after recovery or rollback. A late update cannot recreate a circle that has already been removed. `timeline.ts` owns message history and its changes.

`backup.ts` creates one [chat persistence instance](src/persistence/chat.ts). That instance owns the transaction journal, outgoing queue, checkpoint callbacks, and effects that run after a commit. The circle runtime binds its snapshot, restore, committed, and acknowledged callbacks once. Transactions wait until storage is initialized and that binding exists; a second runtime owner is rejected.

Local checkpoints include chat history. Remote recovery backups omit it. Live circle state uses `isAdmin`, while checkpoint conversion keeps the older `isCreator` field for compatibility with existing backups.

Lifecycle rules come from the saved fields rather than a second saved status. Departure takes precedence over recovery. Members can save drafts while a membership commit is pending, but admin transfer waits for confirmation. Screens and runtime actions use the same rules.

### Following a message

1. The composer calls the circle API exposed by `useCircles()`.
2. `durableAction` initializes the runtime and saves a draft with a stable message ID inside a state transaction.
3. Synchronization catches up with membership changes before encrypting drafts.
4. The encrypted envelope enters the durable outgoing queue. Only committed entries can be uploaded. An uncertain result retries the same ID and bytes.
5. An acknowledgement updates delivery metadata and removes the queued envelope in the same transaction.

Incoming envelopes are processed in mailbox order. Control and application handlers run inside the transaction owned by `circle-sync.ts`. If a membership update or application handler fails, rollback keeps the cursor in place so later messages cannot skip it. Decryption failures are classified separately.

After catch-up, synchronization reseals rejected messages, advances departures, stages the next membership change, and publishes pending messages. Each phase reads current state within its transaction boundary.

`application-payload.ts` checks the shape of decrypted JSON. Unknown message types and malformed required fields are ignored. Invalid optional legacy chat metadata can be dropped without hiding the message. Handlers still need to check the authenticated sender and permissions: the circle-rename receiver currently lacks an admin check, as noted in the root README.

Image attachments have size, format, and header-dimension checks in [attachment.ts](src/attachment.ts), including limits of 8192 pixels per side and 16,777,216 pixels in total. These checks do not replace the native image decoder.

### Rules to preserve

- Save native MLS state, app metadata, and mailbox cursors together. Rollback must restore native and in-memory state.
- Use `afterStateCommit` for notifications and UI effects that depend on a successful save.
- Keep UI subscriptions separate from runtime lifetime. Unmounting a screen must not stop background synchronization.
- Use the shared synchronization coordinator for refresh requests. Periodic callers should not continually queue overlapping passes.
- Treat outgoing application messages from a recovered backup as uncertain. Do not restore remote backups as though they contain local chat history.
- Validate incoming protocol messages separately from UI actions. Hiding a button does not enforce permission on another device.

[diagnostics.ts](src/diagnostics.ts) reports failed phases, known error codes, HTTP status, retryability, and bounded cause chains. It throttles repeated failures and omits message text, stacks, server bodies, and unknown codes. [native-errors.ts](src/native-errors.ts) maps native errors to stable classifications and contains the compatibility parsing for older builds.

## Tests

From `mobile/`:

```bash
npm run typecheck
npm test
```

The Node tests load TypeScript modules with replacements for native storage and network calls. They cover rollback, retries, lost acknowledgements, restart, recovery, background work without mounted screens, and chat and map UI behavior. Map gesture tests use an animation adapter; native layout and touch delivery still need device checks.

After generating `mobile/android/` and building the Rust libraries, run the bridge tests and a release build from that directory:

```bash
./gradlew :app:assembleRelease :family-circle-bridge:testReleaseUnitTest --console=plain -PreactNativeArchitectures=arm64-v8a,x86_64
```

To run the repository's test suites together, use `./scripts/run-all-tests.sh` from the repository root. See the [root test guide](../README.md#tests) for options.

## Emulator checks

### Full walkthrough

From the repository root:

```bash
bash scripts/run-emulator-smoke.sh --rebuild
```

Before running it, prepare the map assets, Rust libraries and bindings, generated Android project, and two AVDs with secondary-user support. The runner needs Linux, Bash, `setsid`, `adb`, Python 3, curl, the .NET SDK, and the Android build dependencies. It does not create AVDs or download map assets.

The APK's bundled URLs must reach the host's ports `5080` and `8090`, usually through `http://10.0.2.2`. Ports `5080`, `8090`, and `8091` must be free. The runner leaves existing services alone and uses local tiles even when normal development uses a hosted provider.

`--rebuild` builds and installs a fresh release APK on both emulators. Without it, ready emulators keep their installed APK; if either emulator is unready or lacks the app, the runner prepares both using [push-two-emulators-release.sh](../scripts/push-two-emulators-release.sh). Use `--rebuild` after source changes so the checks run against the current app.

The walkthrough starts an isolated relay and map gateway, then checks onboarding, invitations, messages, replies, reactions, editing, deletion, location sharing, map gestures, and offline restart. Location checks use a synthetic GPS fix in Warsaw and include stopping a session and waiting for a one-minute session to expire.

Tests run in temporary Android users to preserve the usual identities and circles. The runner switches back and removes those users afterward, including on failure or interruption. It stops its services and leaves the emulators running. Recovery phrases are not printed.

Each run leaves a directory under `/tmp` with a summary, service and test logs, and the isolated relay database. Failed UI checks save screenshots and UI hierarchies under `artifacts/` before cleanup. A nonzero exit status means failure or interruption.

| Option | Use it to |
| --- | --- |
| `--first SERIAL`, `--second SERIAL` | Select emulators; defaults are `emulator-5554` and `emulator-5556` |
| `--avd-1 NAME`, `--avd-2 NAME` | Select AVDs for preparation; otherwise names are detected or default to `Pixel_10_Pro_XL` and `Pixel_10_Pro_XL_2` |
| `--logs-dir DIRECTORY` | Choose the parent directory for run logs |
| `--startup-timeout SECONDS` | Allow more time for services to start; default is 120 seconds |

### Smaller checks with services already running

With the same current APK on both emulators and an existing test circle visible on both home screens, run from `mobile/`:

```bash
python3 scripts/emulator-smoke.py --circle 'Refactor QA' --chat-actions --offline-restart
```

This adds test messages and checks delivery, reactions, replies, edits, deletion, and saved edit history across restarts. The offline check disables connectivity on the first emulator, saves a draft, restarts the app, and checks delivery after reconnecting. It restores the previous Wi-Fi and mobile-data settings even if a check fails. Omit `--chat-actions` for a smaller delivery check, or `--offline-restart` to skip the connection-loss test.

For map navigation and selection without changing sharing consent:

```bash
python3 scripts/emulator-smoke.py --circle 'Refactor QA' --map-only
```

This uses the first emulator and returns to chat. Pin selection is skipped if nobody is sharing a location.

To run the setup and location suite against services you manage yourself, run from the repository root:

```bash
bash mobile/scripts/run-setup-smoke.sh
```

This wrapper also uses temporary Android users. Set `FC_SMOKE_FIRST` and `FC_SMOKE_SECOND` to select another emulator pair. When running the wrapper directly, `FC_SMOKE_KEEP_FAILED=1` preserves failed test users for inspection; the full runner always cleans them up. Use a development relay, since test mailboxes and encrypted backups remain there.

On two dedicated fresh installs, you can instead run the Python checks directly:

```bash
python3 mobile/scripts/emulator-smoke.py --first emulator-5558 --second emulator-5560 \
  --setup --create-join --location-sharing
```

Direct runs use the current Android users. Omit `--setup` if they already have identities. `--create-join` creates a new circle with a unique name and is required by `--location-sharing`. Those checks stop any sharing they started if a later assertion fails. Set `FC_SMOKE_ARTIFACTS` to choose where direct runs save failure evidence.

Emulator checks cover permission prompts and app behavior. Check attachment picking, audio, QR scanning, admin handover, real GPS, and battery use on devices too. UI checks do not establish protocol authorization guarantees.
