// The page's words (A5 3.23): ICU messages in `en.json`, the source catalogue, through FormatJS
// (`react-intl`). Components never hold a UI string: lint refuses a literal in JSX
// (eslint-plugin-formatjs), and every message ID is a key of the catalogue, checked by the
// compiler. Plurals and selects are ICU; nothing is concatenated.
//
// Every product name comes from packages/brand: a message says `{product}`, `{cli}`, `{monitor}` or
// `{monitorCli}`, and `t` supplies them, so the rename touches no message.
import { useCallback, type ReactNode } from "react";
import { IntlProvider, useIntl } from "react-intl";
import { CLI_NAME, MONITOR_COMMAND, MONITOR_NAME, PRODUCT_NAME } from "@ttasks/brand";
import en from "./en.json" with { type: "json" };

/** The catalogue's message IDs. */
export type MessageId = keyof typeof en;

/** The values a message takes. */
export type Values = Readonly<Record<string, string | number>>;

/** The source locale. Translations join as `<locale>.json` beside it. */
export const SOURCE_LOCALE = "en";

export const CATALOGUE: Readonly<Record<MessageId, string>> = en;

/** The names every message may use. */
export const BRAND_VALUES = {
  product: PRODUCT_NAME,
  cli: CLI_NAME,
  monitor: MONITOR_NAME,
  monitorCli: MONITOR_COMMAND,
} as const;

export function I18n({ children }: { readonly children: ReactNode }) {
  return (
    <IntlProvider locale={SOURCE_LOCALE} defaultLocale={SOURCE_LOCALE} messages={CATALOGUE}>
      {children}
    </IntlProvider>
  );
}

export type Translate = (id: MessageId, values?: Values) => string;

/** Items joined as the page's locale joins a list: "a, b and c". */
export function useList(): (items: readonly string[]) => string {
  const intl = useIntl();
  return useCallback(
    (items: readonly string[]) => intl.formatList(items, { type: "conjunction" }),
    [intl],
  );
}

/** `t(id, values)`: the message in the page's locale, with the brand's names. */
export function useT(): Translate {
  const intl = useIntl();
  return useCallback(
    (id: MessageId, values?: Values) => intl.formatMessage({ id }, { ...BRAND_VALUES, ...values }),
    [intl],
  );
}
