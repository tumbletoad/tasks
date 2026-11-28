// Settings > Phones: the phones paired with this computer, each with its space, when it was last
// used, its Run switch and Remove; and Pair a phone, a dialog with a one-use code as a QR code.
// The dialog says plainly what the code allows, follows the code until a phone has used it, and
// ends the code when it closes.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
  SwitchButton,
  SwitchField,
} from "react-aria-components";
import { useT } from "../i18n/intl.tsx";
import { formatWhen } from "../row/dates.ts";
import { useClock } from "../row/useClock.ts";
import { classes } from "./css.ts";
import { useToast } from "./frame.ts";
import { phoneCalls, qrPath, type Phone, type PhoneCode } from "./phones.ts";
import { useMachineApi } from "./session.tsx";
import css from "./Phones.module.css";
import settingsCss from "./Settings.module.css";
import setupCss from "./Setup.module.css";

const styles = classes(css, ["list", "phone", "who", "facts", "qr", "plate", "warning", "code"]);
const settings = classes(settingsCss, [
  "section",
  "heading",
  "description",
  "button",
  "switch",
  "track",
  "thumb",
  "name",
]);
const sheet = classes(setupCss, [
  "overlay",
  "modal",
  "dialog",
  "title",
  "lead",
  "note",
  "actions",
  "primary",
  "secondary",
  "quiet",
  "error",
]);

/** How often an open dialog asks whether its code was used. */
const FOLLOW_MS = 2000;

export function Phones({ space }: { readonly space: string }) {
  const t = useT();
  const say = useToast();
  const api = useMachineApi();
  const calls = useMemo(() => phoneCalls(api), [api]);
  const [phones, setPhones] = useState<readonly Phone[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<Phone | undefined>(undefined);

  const load = useCallback(() => {
    calls.view().then(
      (view) => {
        setPhones(view.phones);
        setFailed(false);
      },
      () => {
        setFailed(true);
      },
    );
  }, [calls]);
  useEffect(load, [load]);

  return (
    <section className={settings.section} aria-labelledby="settings-phones">
      <Heading id="settings-phones" level={2} className={settings.heading}>
        {t("phones.title")}
      </Heading>
      <p className={settings.description}>{t("phones.lead")}</p>
      {failed ? <p className={settings.description}>{t("phones.failed")}</p> : null}
      {phones !== undefined && phones.length > 0 ? (
        <ul className={styles.list}>
          {phones.map((phone) => (
            <PhoneRow
              key={phone.id}
              phone={phone}
              onRun={(run) => {
                calls.run(phone.id, run).then(load, () => {
                  say(t("phones.notSaved"));
                });
              }}
              onRemove={() => {
                setRemoving(phone);
              }}
            />
          ))}
        </ul>
      ) : null}
      <Button
        className={settings.button}
        onPress={() => {
          setPairing(true);
        }}
      >
        {t("phones.pair")}
      </Button>
      {pairing ? (
        <PairDialog
          space={space}
          onClose={() => {
            setPairing(false);
            load();
          }}
        />
      ) : null}
      {removing === undefined ? null : (
        <RemoveDialog
          phone={removing}
          onClose={(removed) => {
            setRemoving(undefined);
            if (removed === false) say(t("phones.notSaved"));
            load();
          }}
          remove={() => calls.remove(removing.id)}
        />
      )}
    </section>
  );
}

function PhoneRow({
  phone,
  onRun,
  onRemove,
}: {
  readonly phone: Phone;
  readonly onRun: (run: boolean) => void;
  readonly onRemove: () => void;
}) {
  const t = useT();
  const clock = useClock(true);
  const used = phone.lastUsedAt === null ? undefined : Date.parse(phone.lastUsedAt);
  const name = phone.name === "" ? t("phones.unnamed") : phone.name;
  return (
    <li className={styles.phone}>
      <span className={styles.who}>{name}</span>
      <span className={styles.facts}>
        {t("phones.facts", {
          space: phone.spaceName ?? t("phones.spaceGone"),
          used: used === undefined ? t("phones.neverUsed") : formatWhen(used, clock),
        })}
      </span>
      <SwitchField
        isSelected={phone.run}
        onChange={onRun}
        aria-label={t("phones.runFor", { name })}
      >
        <SwitchButton className={settings.switch}>
          <span className={settings.track} aria-hidden="true">
            <span className={settings.thumb} />
          </span>
          <span className={settings.name}>{t("phones.run")}</span>
        </SwitchButton>
      </SwitchField>
      <Button
        className={settings.button}
        onPress={onRemove}
        aria-label={t("phones.removeFor", { name })}
      >
        {t("phones.remove")}
      </Button>
    </li>
  );
}

function PairDialog({ space, onClose }: { readonly space: string; readonly onClose: () => void }) {
  const t = useT();
  const api = useMachineApi();
  const calls = useMemo(() => phoneCalls(api), [api]);
  const [code, setCode] = useState<PhoneCode | undefined>(undefined);
  const [state, setState] = useState<"making" | "waiting" | "paired" | "ended" | "failed">(
    "making",
  );
  const [paired, setPaired] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    let made: PhoneCode | undefined;
    calls.pair(space).then(
      (c) => {
        made = c;
        if (!live) {
          void calls.end(c.ticket).catch(() => undefined);
          return;
        }
        setCode(c);
        setState("waiting");
      },
      () => {
        if (live) setState("failed");
      },
    );
    return () => {
      live = false;
      // The code ends with its dialog: a photo of it pairs nothing after that.
      if (made !== undefined) void calls.end(made.ticket).catch(() => undefined);
    };
  }, [calls, space]);

  useEffect(() => {
    if (code === undefined || state !== "waiting") return;
    const timer = setInterval(() => {
      calls.view(code.ticket).then(
        (view) => {
          const pairing = view.pairing;
          if (pairing?.state === "paired") {
            setPaired(view.phones.find((p) => p.id === pairing.phone)?.name ?? "");
            setState("paired");
          } else if (pairing?.state === "ended") {
            setState("ended");
          }
        },
        () => undefined,
      );
    }, FOLLOW_MS);
    return () => {
      clearInterval(timer);
    };
  }, [calls, code, state]);

  const qr = useMemo(() => (code === undefined ? undefined : qrPath(code.code)), [code]);
  return (
    <ModalOverlay
      className={sheet.overlay}
      isOpen
      isDismissable
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Modal className={sheet.modal}>
        <Dialog className={sheet.dialog} aria-label={t("phones.pairTitle")}>
          <Heading slot="title" level={2} className={sheet.title}>
            {t("phones.pairTitle")}
          </Heading>
          {state === "paired" ? (
            <p className={sheet.lead}>
              {t("phones.paired", { name: paired || t("phones.unnamed") })}
            </p>
          ) : state === "failed" ? (
            <p className={sheet.error}>{t("phones.codeFailed")}</p>
          ) : state === "ended" ? (
            <p className={sheet.lead}>{t("phones.codeEnded")}</p>
          ) : (
            <>
              <p className={sheet.lead}>{t("phones.scan")}</p>
              {qr === undefined ? null : (
                <div className={styles.plate}>
                  <svg
                    className={styles.qr}
                    viewBox={`0 0 ${String(qr.size)} ${String(qr.size)}`}
                    role="img"
                    aria-label={t("phones.qrLabel")}
                    shapeRendering="crispEdges"
                  >
                    <rect width={qr.size} height={qr.size} fill="#ffffff" />
                    <path d={qr.d} fill="#000000" />
                  </svg>
                </div>
              )}
              <p className={styles.warning}>{t("phones.warning")}</p>
              <p className={sheet.note}>
                {code !== undefined && code.addresses === 0
                  ? t("phones.noNetwork")
                  : t("phones.network")}
              </p>
            </>
          )}
          <div className={sheet.actions}>
            {state === "waiting" && code !== undefined ? (
              <Button
                className={sheet.quiet}
                onPress={() => {
                  void navigator.clipboard.writeText(code.code).catch(() => undefined);
                }}
              >
                {t("phones.copy")}
              </Button>
            ) : null}
            <Button className={state === "paired" ? sheet.primary : sheet.secondary} slot="close">
              {state === "paired" ? t("phones.done") : t("phones.close")}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function RemoveDialog({
  phone,
  remove,
  onClose,
}: {
  readonly phone: Phone;
  readonly remove: () => Promise<unknown>;
  readonly onClose: (removed?: boolean) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const name = phone.name === "" ? t("phones.unnamed") : phone.name;
  return (
    <ModalOverlay
      className={sheet.overlay}
      isOpen
      isDismissable
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Modal className={sheet.modal}>
        <Dialog
          className={sheet.dialog}
          role="alertdialog"
          aria-label={t("phones.removeTitle", { name })}
        >
          <Heading slot="title" level={2} className={sheet.title}>
            {t("phones.removeTitle", { name })}
          </Heading>
          <p className={sheet.lead}>{t("phones.removeLead")}</p>
          <div className={sheet.actions}>
            <Button className={sheet.secondary} slot="close">
              {t("phones.cancel")}
            </Button>
            <Button
              className={sheet.primary}
              isDisabled={busy}
              onPress={() => {
                setBusy(true);
                remove().then(
                  () => {
                    onClose(true);
                  },
                  () => {
                    onClose(false);
                  },
                );
              }}
            >
              {t("phones.remove")}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
