// A task's card, to read: where the task sits, a question an agent left on top, its Brief, dates,
// priority, effort and what it waits on (from its live row), then its Description, its notes and
// log entries newest first with who wrote each, and its Knowledge (from the computer, read again
// when the row moves). A page opens from the Knowledge to read. Without the computer the card shows
// the phone's last read with its age, or says it has not been loaded.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  runLine,
  type CardDetail,
  type PageLink,
  type PageText,
  type PhoneRun,
  type Read,
  type SpaceSession,
} from "@ttasks/client/link";
import { trail, type NodeRow, type TaskRow } from "@ttasks/client/store";
import { dueWhen, formatDay, formatWhen, type Clock } from "@ttasks/client/today";
import { ago } from "./time.ts";
import { Button, shared, type Colors } from "./ui.tsx";
import { WORDS } from "./words.ts";

const DAY = { weekday: "short", day: "numeric", month: "short" } as const;

/** A read from the session, read again whenever `again` changes. */
function useRead<T>(read: () => Promise<Read<T>>, again: string): Read<T> | undefined {
  const [value, setValue] = useState<Read<T> | undefined>(undefined);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    let current = true;
    void reader.current().then((next) => {
      // A read that found nothing never hides one already shown.
      if (current)
        setValue((shown) => (next.kind === "none" && shown !== undefined ? shown : next));
    });
    return () => {
      current = false;
    };
  }, [again]);
  return value;
}

/** How fresh a read is, in a line: nothing while live. */
function Age(props: { read: Read<unknown> | undefined; clock: Clock; colors: Colors }) {
  const { read, clock, colors } = props;
  const words =
    read === undefined
      ? WORDS.loading
      : read.kind === "none"
        ? WORDS.notLoaded
        : read.kind === "gone"
          ? WORDS.pageGone
          : read.live
            ? undefined
            : WORDS.updated(ago(read.at, clock.now));
  return words === undefined ? null : (
    <Text style={[shared.small, { color: colors.muted }]}>{words}</Text>
  );
}

export function Card(props: {
  task: TaskRow;
  /** Checked off on this phone, in its moment for Undo. */
  done: boolean;
  onUndo?: () => void;
  nodes: ReadonlyMap<string, NodeRow>;
  clock: Clock;
  colors: Colors;
  session: SpaceSession;
  /** The link is up: a read now can be the computer's. */
  live: boolean;
  onBack: () => void;
  onCheck: (task: TaskRow) => void;
  onPage: (page: PageLink) => void;
}) {
  const { task, done, onUndo, nodes, clock, colors, session, live, onBack, onCheck, onPage } =
    props;
  const read = useRead<CardDetail>(
    () => session.card(task.id),
    `${task.id} ${String(task.version)} ${String(task.touched)} ${String(live)}`,
  );
  const crumbs = trail(nodes, task.parent).map((node) => node.title);
  const facts = [
    ((due) => (due === undefined ? undefined : WORDS.due(due)))(dueWhen(task, clock)),
    task.planned_for === undefined
      ? undefined
      : WORDS.planned(formatDay(task.planned_for, clock.locale, DAY)),
    task.priority === undefined ? undefined : WORDS.priority(task.priority),
    task.effort === undefined ? undefined : WORDS.effort(task.effort),
    task.waiting_on === undefined ? undefined : WORDS.waitingOn(task.waiting_on),
  ].filter((fact): fact is string => fact !== undefined);
  const detail = read?.kind === "read" ? read.value : undefined;
  // The task's newest run, read again whenever its row says the run moved.
  const runs = useRead<readonly PhoneRun[]>(
    () => session.runs(task.id),
    `${task.id} ${String(task.run?.id)} ${String(task.run?.state)} ${String(live)}`,
  );
  const newest = runs?.kind === "read" ? runs.value[0] : undefined;
  const run = newest === undefined ? undefined : runLine(newest);

  return (
    <View style={shared.fill}>
      <View style={[styles.bar, { borderColor: colors.line }]}>
        <Button label={WORDS.back} onPress={onBack} colors={colors} quiet />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {crumbs.length === 0 ? null : (
          <Text style={[shared.small, { color: colors.muted }]}>{crumbs.join(" › ")}</Text>
        )}
        <View style={styles.title}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: done, disabled: done }}
            accessibilityLabel={WORDS.finish(task.title)}
            disabled={done}
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
          <Text
            style={[
              shared.title,
              styles.grow,
              { color: done ? colors.muted : colors.text },
              done ? styles.struck : null,
            ]}
          >
            {task.title}
          </Text>
        </View>
        {onUndo === undefined ? null : (
          <Button label={WORDS.undo} onPress={onUndo} colors={colors} quiet />
        )}
        {(task.questions ?? []).map((q) => (
          <View key={q.ref} style={[styles.question, { borderColor: colors.accent }]}>
            <Text style={[shared.small, { color: colors.accent }]}>
              {WORDS.question(WORDS.who(q.by))}
            </Text>
            <Text style={[shared.body, { color: colors.text }]}>{q.text}</Text>
          </View>
        ))}
        {task.summary === undefined || task.summary === "" ? null : (
          <Section label={WORDS.brief} colors={colors}>
            <Text style={[shared.body, { color: colors.text }]}>{task.summary}</Text>
          </Section>
        )}
        {facts.length === 0 ? null : (
          <Text style={[shared.small, { color: colors.muted }]}>{facts.join(" · ")}</Text>
        )}
        {run === undefined ? null : (
          <Section label={WORDS.runSection} colors={colors}>
            <Text
              style={[
                shared.body,
                { color: run.tone === "needs_you" ? colors.accent : colors.text },
              ]}
            >
              {WORDS.run[run.tone]}
            </Text>
            {run.said === undefined ? null : (
              <View style={styles.entry}>
                <Text style={[shared.small, { color: colors.muted }]}>
                  {WORDS.said[run.said.kind]}
                </Text>
                <Text style={[shared.body, { color: colors.text }]}>{run.said.text}</Text>
                {run.said.cut ? (
                  <Text style={[shared.small, { color: colors.muted }]}>{WORDS.cut}</Text>
                ) : null}
              </View>
            )}
          </Section>
        )}
        <Age read={read} clock={clock} colors={colors} />
        {detail?.partial === true ? (
          <Text style={[shared.small, { color: colors.muted }]}>{WORDS.partial}</Text>
        ) : null}
        {detail === undefined || detail.description === "" ? null : (
          <Section label={WORDS.description} colors={colors}>
            <Text style={[shared.body, { color: colors.text }]}>{detail.description}</Text>
          </Section>
        )}
        {detail === undefined ? null : (
          <Section label={WORDS.thread} colors={colors}>
            {detail.entries.length === 0 && !detail.partial ? (
              <Text style={[shared.small, { color: colors.muted }]}>{WORDS.nothingYet}</Text>
            ) : (
              detail.entries.map((entry) => (
                <View key={`${entry.kind}${entry.ref}`} style={styles.entry}>
                  <Text style={[shared.body, { color: colors.text }]}>{entry.text}</Text>
                  <Text style={[shared.small, { color: colors.muted }]}>
                    {`${WORDS.who(entry.by)} · ${formatWhen(Date.parse(entry.at), clock)}`}
                  </Text>
                </View>
              ))
            )}
          </Section>
        )}
        {detail === undefined || (detail.pages.length === 0 && detail.above.length === 0) ? null : (
          <Section label={WORDS.knowledge} colors={colors}>
            {detail.pages.map((page) => (
              <PageRow key={page.ref} page={page} colors={colors} onPage={onPage} />
            ))}
            {detail.above.length === 0 ? null : (
              <Text style={[shared.small, styles.above, { color: colors.muted }]}>
                {WORDS.fromAbove}
              </Text>
            )}
            {detail.above.map((level) => (
              <View key={`${level.kind}${level.title}`} style={styles.level}>
                <Text style={[shared.small, { color: colors.muted }]}>{level.title}</Text>
                {level.pages.map((page) => (
                  <PageRow key={page.ref} page={page} colors={colors} onPage={onPage} />
                ))}
              </View>
            ))}
          </Section>
        )}
      </ScrollView>
    </View>
  );
}

function Section(props: { label: string; colors: Colors; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: props.colors.muted }]}>{props.label}</Text>
      {props.children}
    </View>
  );
}

function PageRow(props: { page: PageLink; colors: Colors; onPage: (page: PageLink) => void }) {
  const { page, colors, onPage } = props;
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => {
        onPage(page);
      }}
      style={styles.page}
    >
      <Text style={[shared.body, { color: colors.accent }]}>{page.title}</Text>
      {page.brief === "" ? null : (
        <Text style={[shared.small, { color: colors.muted }]}>{page.brief}</Text>
      )}
    </Pressable>
  );
}

/** A page opened from a card, to read: its title, brief and text. */
export function PageView(props: {
  page: PageLink;
  clock: Clock;
  colors: Colors;
  session: SpaceSession;
  live: boolean;
  onBack: () => void;
}) {
  const { page, clock, colors, session, live, onBack } = props;
  const [front, setFront] = useState(0);
  useEffect(() => {
    const app = AppState.addEventListener("change", (now) => {
      if (now === "active") setFront((n) => n + 1);
    });
    return () => {
      app.remove();
    };
  }, []);
  const read = useRead<PageText>(
    () => session.page(page.ref),
    `${page.ref} ${String(live)} ${String(front)}`,
  );
  const text = read?.kind === "read" ? read.value : undefined;
  return (
    <View style={shared.fill}>
      <View style={[styles.bar, { borderColor: colors.line }]}>
        <Button label={WORDS.back} onPress={onBack} colors={colors} quiet />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[shared.title, { color: colors.text }]}>{text?.title ?? page.title}</Text>
        {(text?.brief ?? page.brief) === "" ? null : (
          <Text style={[shared.small, { color: colors.muted }]}>{text?.brief ?? page.brief}</Text>
        )}
        <Age read={read} clock={clock} colors={colors} />
        {text?.partial === true ? (
          <Text style={[shared.small, { color: colors.muted }]}>{WORDS.partial}</Text>
        ) : null}
        {text === undefined ? null : (
          <Text style={[shared.body, { color: colors.text }]}>{text.body}</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 20, paddingTop: 40, paddingBottom: 8, borderBottomWidth: 1 },
  body: { padding: 20, gap: 12 },
  title: { flexDirection: "row", alignItems: "flex-start", gap: 14 },
  box: { width: 24, height: 24, borderWidth: 2, borderRadius: 6, marginTop: 6 },
  grow: { flex: 1 },
  struck: { textDecorationLine: "line-through" },
  question: { borderLeftWidth: 3, paddingLeft: 12, gap: 4 },
  section: { gap: 8, paddingTop: 8 },
  label: { fontSize: 13, fontWeight: "600" },
  entry: { gap: 2 },
  above: { paddingTop: 8 },
  level: { gap: 6 },
  page: { gap: 2, paddingVertical: 4 },
});
