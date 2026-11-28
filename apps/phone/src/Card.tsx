// A task's card, to read: where the task sits, a question an agent left on top, its Brief, dates,
// priority, effort and what it waits on (from its live row), then its Description, its notes and
// log entries newest first with who wrote each, and its Knowledge (from the computer, read again
// when the row moves). A page opens from the Knowledge to read. Without the computer the card shows
// the phone's last read with its age, or says it has not been loaded.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { CardDetail, PageLink, PageText, Read, SpaceSession } from "@ttasks/client/link";
import { trail, type NodeRow, type TaskRow } from "@ttasks/client/store";
import { formatDay, formatWhen, type Clock } from "@ttasks/client/today";
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
        : read.live
          ? undefined
          : WORDS.updated(ago(read.at, clock.now));
  return words === undefined ? null : (
    <Text style={[shared.small, { color: colors.muted }]}>{words}</Text>
  );
}

export function Card(props: {
  task: TaskRow;
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
  const { task, nodes, clock, colors, session, live, onBack, onCheck, onPage } = props;
  const read = useRead<CardDetail>(
    () => session.card(task.id),
    `${task.id} ${String(task.version)} ${String(task.touched)} ${String(live)}`,
  );
  const crumbs = trail(nodes, task.parent).map((node) => node.title);
  const facts = [
    task.due_date === undefined
      ? undefined
      : WORDS.due(formatDay(task.due_date, clock.locale, DAY)),
    task.planned_for === undefined
      ? undefined
      : WORDS.planned(formatDay(task.planned_for, clock.locale, DAY)),
    task.priority === undefined ? undefined : WORDS.priority(task.priority),
    task.effort === undefined ? undefined : WORDS.effort(task.effort),
    task.waiting_on === undefined ? undefined : WORDS.waitingOn(task.waiting_on),
  ].filter((fact): fact is string => fact !== undefined);
  const detail = read?.kind === "read" ? read.value : undefined;

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
            accessibilityState={{ checked: false }}
            accessibilityLabel={WORDS.finish(task.title)}
            onPress={() => {
              onCheck(task);
            }}
            hitSlop={10}
            style={[styles.box, { borderColor: colors.muted }]}
          />
          <Text style={[shared.title, styles.grow, { color: colors.text }]}>{task.title}</Text>
        </View>
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
        <Age read={read} clock={clock} colors={colors} />
        {detail === undefined || detail.description === "" ? null : (
          <Section label={WORDS.description} colors={colors}>
            <Text style={[shared.body, { color: colors.text }]}>{detail.description}</Text>
          </Section>
        )}
        {detail === undefined ? null : (
          <Section label={WORDS.thread} colors={colors}>
            {detail.entries.length === 0 ? (
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
  const read = useRead<PageText>(() => session.page(page.ref), `${page.ref} ${String(live)}`);
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
  question: { borderLeftWidth: 3, paddingLeft: 12, gap: 4 },
  section: { gap: 8, paddingTop: 8 },
  label: { fontSize: 13, fontWeight: "600" },
  entry: { gap: 2 },
  above: { paddingTop: 8 },
  level: { gap: 6 },
  page: { gap: 2, paddingVertical: 4 },
});
