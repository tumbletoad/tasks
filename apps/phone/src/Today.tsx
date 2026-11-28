// Today for the paired space: Focus, This week and Next, as the page shows them (`todayOf`), live
// from the computer's feed. A task's box checks it off, with Undo for a moment while the row stays
// checked at its place; the field at the bottom captures a task where the page's capture puts it.
// Without the computer the last rows stay, with how old they are, and what the person does waits to
// be sent. One session holds the link: it opens at launch and when the app comes back to the front,
// again on another network, retries while it is down, and holds nothing in the background.
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { PRODUCT_NAME } from "@ttasks/brand";
import { captureGroups, parseCapture } from "@ttasks/client/capture";
import { spaceSession, type Saved, type SpaceSession, type SpaceView } from "@ttasks/client/link";
import type { TaskRow } from "@ttasks/client/store";
import { formatDay, todayOf, type Clock } from "@ttasks/client/today";
import { localDate } from "@ttasks/contracts/day";
import { connectSocket, native } from "./link/socket.ts";
import { Button, shared, type Colors } from "./ui.tsx";
import { WORDS } from "./words.ts";

/** How long a checked-off row stays at its place, with Undo. */
const HOLD_MS = 5_000;

const keep = { read: (name: string) => native.kept(name), write: native.keep.bind(native) };

/** Now, today and the phone's own zone and language: read again every minute. */
function useClock(): Clock {
  const make = (): Clock => {
    const now = Date.now();
    const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions();
    return { now, today: localDate(now, timeZone), timeZone, locale };
  };
  const [clock, setClock] = useState(make);
  useEffect(() => {
    const timer = setInterval(() => {
      setClock(make());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return clock;
}

function ago(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return WORDS.justNow;
  if (minutes < 60) return WORDS.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? WORDS.hours(hours) : WORDS.days(Math.floor(hours / 24));
}

interface Held {
  readonly task: TaskRow;
  readonly request: string;
}

export function Today(props: {
  saved: Saved;
  colors: Colors;
  onScan: () => void;
  onRemoved: () => void;
}) {
  const { saved, colors, onScan, onRemoved } = props;
  const clock = useClock();
  const [view, setView] = useState<SpaceView | undefined>(undefined);
  const [space, setSpace] = useState(saved.space.name);
  const [held, setHeld] = useState<ReadonlyMap<string, Held>>(new Map());
  const [text, setText] = useState("");
  const [mine, setMine] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const session = useRef<SpaceSession | undefined>(undefined);
  const removed = useRef(onRemoved);
  removed.current = onRemoved;

  useEffect(() => {
    let named = JSON.stringify(saved);
    const live = spaceSession({
      connect: connectSocket,
      saved,
      keep,
      newId: () => native.newId(),
      report: (next, pairing) => {
        setView(next);
        setSpace(pairing.space.name);
        const json = JSON.stringify(pairing);
        if (next.link.kind === "connected" && json !== named) {
          named = json;
          native.savePairing(json);
        }
        if (next.link.kind === "removed") removed.current();
      },
    });
    session.current = live;
    // A pairing that ended after the app went to the background waits for the front.
    if (AppState.currentState !== "background") live.start();
    const app = AppState.addEventListener("change", (now) => {
      if (now === "active") live.start();
      else if (now === "background") live.stop();
    });
    const network = native.addListener("network", () => {
      live.now();
    });
    return () => {
      live.stop();
      app.remove();
      network.remove();
    };
  }, [saved]);

  const nodes = view?.nodes;
  const sections = useMemo(() => {
    const tasks = new Map(view?.tasks ?? []);
    for (const [id, hold] of held) tasks.set(id, hold.task);
    return todayOf(tasks.values(), clock).sections.map((section) => ({
      key: section.key,
      title: WORDS.section[section.key],
      data: [...section.tasks],
    }));
  }, [view, held, clock]);

  const check = (task: TaskRow) => {
    const live = session.current;
    if (live === undefined || held.has(task.id)) return;
    const request = live.finish(task);
    setHeld((now) => new Map(now).set(task.id, { task, request }));
    setTimeout(() => {
      setHeld((now) => {
        if (now.get(task.id)?.request !== request) return now;
        const next = new Map(now);
        next.delete(task.id);
        return next;
      });
    }, HOLD_MS);
  };
  const undo = (hold: Held) => {
    session.current?.undo(hold.request);
    setHeld((now) => {
      const next = new Map(now);
      next.delete(hold.task.id);
      return next;
    });
  };

  const add = () => {
    const live = session.current;
    if (live === undefined || text.trim() === "") return;
    const capture = parseCapture(text, {
      today: clock.today,
      ...captureGroups(nodes ?? new Map()),
    });
    if (capture.draft === undefined) {
      setNote(WORDS.noTitle);
      return;
    }
    setMine(live.add(capture.draft, text));
    setNote(undefined);
    setText("");
  };

  const link = view?.link ?? { kind: "connecting" as const };
  const state =
    link.kind === "connected"
      ? WORDS.connected
      : link.kind === "offline"
        ? WORDS.away
        : WORDS.connecting;
  const lastHold = [...held.values()].at(-1);
  const captured =
    mine === undefined
      ? undefined
      : view?.added === mine
        ? WORDS.added
        : view?.waiting.some((w) => w.request === mine) === true && !view.live
          ? WORDS.addedLater
          : undefined;

  return (
    <View style={shared.fill}>
      <View style={[styles.head, { borderColor: colors.line }]}>
        <Text style={[styles.space, { color: colors.text }]}>
          {space === "" ? PRODUCT_NAME : space}
        </Text>
        <Text style={[shared.small, { color: colors.muted }]}>
          {state}
          {view?.live !== true && view?.asOf !== undefined && view.loaded
            ? ` ${WORDS.updated(ago(view.asOf, clock.now))}`
            : ""}
        </Text>
        {link.kind === "offline" && link.pin ? (
          <Text style={[shared.small, { color: colors.muted }]}>{WORDS.otherKey}</Text>
        ) : null}
        {link.kind === "offline" ? (
          <Button
            label={WORDS.tryNow}
            onPress={() => session.current?.now()}
            colors={colors}
            quiet
          />
        ) : null}
        {view !== undefined && view.waiting.length > 0 ? (
          <Text style={[shared.small, { color: colors.muted }]}>
            {WORDS.waiting(view.waiting.length)}
          </Text>
        ) : null}
        {view?.refused.map((refusal) => (
          <View key={refusal.request} style={styles.refused}>
            <Text style={[shared.small, styles.grow, { color: colors.text }]}>
              {WORDS.notSaved(refusal.words, refusal.why)}
            </Text>
            <Button
              label={WORDS.dismiss}
              onPress={() => session.current?.dismiss(refusal.request)}
              colors={colors}
              quiet
            />
          </View>
        ))}
      </View>
      <SectionList
        style={shared.fill}
        sections={sections}
        keyExtractor={(task) => task.id}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.section, { color: colors.muted }]}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <Row task={item} done={held.has(item.id)} colors={colors} clock={clock} onCheck={check} />
        )}
        ListEmptyComponent={
          <Text style={[shared.body, styles.empty, { color: colors.muted }]}>
            {view?.loaded === true ? WORDS.nothing : WORDS.loading}
          </Text>
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <Button label={WORDS.scanNew} onPress={onScan} colors={colors} quiet />
          </View>
        }
      />
      {lastHold === undefined ? null : (
        <View style={[styles.toast, { backgroundColor: colors.text }]}>
          <Text style={[shared.small, styles.grow, { color: colors.background }]} numberOfLines={1}>
            {WORDS.doneToast(lastHold.task.title)}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              undo(lastHold);
            }}
            hitSlop={12}
          >
            <Text style={[styles.undo, { color: colors.background }]}>{WORDS.undo}</Text>
          </Pressable>
        </View>
      )}
      <View style={[styles.capture, { borderColor: colors.line }]}>
        {(note ?? captured) ? (
          <Text style={[shared.small, { color: colors.muted }]}>{note ?? captured}</Text>
        ) : null}
        <TextInput
          style={[shared.input, { color: colors.text, borderColor: colors.muted }]}
          value={text}
          onChangeText={(next) => {
            setText(next);
            setNote(undefined);
          }}
          onSubmitEditing={add}
          submitBehavior="submit"
          returnKeyType="done"
          placeholder={WORDS.addTask}
          placeholderTextColor={colors.muted}
          accessibilityLabel={WORDS.newTask}
        />
      </View>
    </View>
  );
}

function Row(props: {
  task: TaskRow;
  done: boolean;
  colors: Colors;
  clock: Clock;
  onCheck: (task: TaskRow) => void;
}) {
  const { task, done, colors, clock, onCheck } = props;
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={WORDS.finish(task.title)}
        onPress={() => {
          onCheck(task);
        }}
        hitSlop={10}
        style={[
          styles.box,
          { borderColor: colors.muted },
          done ? { backgroundColor: colors.accent, borderColor: colors.accent } : null,
        ]}
      />
      <View style={styles.grow}>
        <Text
          style={[
            shared.body,
            { color: done ? colors.muted : colors.text },
            done ? styles.struck : null,
          ]}
        >
          {task.title}
        </Text>
        {task.due_date === undefined ? null : (
          <Text style={[shared.small, { color: colors.muted }]}>
            {WORDS.due(
              formatDay(task.due_date, clock.locale, {
                weekday: "short",
                day: "numeric",
                month: "short",
              }),
            )}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 20, paddingTop: 48, paddingBottom: 12, gap: 4, borderBottomWidth: 1 },
  space: { fontSize: 24, fontWeight: "600" },
  section: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 6,
    fontSize: 13,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  box: { width: 22, height: 22, borderWidth: 2, borderRadius: 6, marginTop: 1 },
  grow: { flex: 1 },
  struck: { textDecorationLine: "line-through" },
  empty: { padding: 20 },
  footer: { padding: 20 },
  refused: { flexDirection: "row", alignItems: "center", gap: 8 },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
  },
  undo: { fontSize: 15, fontWeight: "700" },
  capture: { padding: 16, gap: 6, borderTopWidth: 1 },
});
