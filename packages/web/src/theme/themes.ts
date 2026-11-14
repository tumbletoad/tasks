// The themes v1 ships, Sumi and Washi, loaded through validateTheme like any later theme (A5
// 3.19: "the v1 code already loads Sumi and Washi through this same path"). The build writes their
// custom properties into the stylesheet (build.ts), and the contrast test reads the same objects.
import sumiData from "./sumi.json" with { type: "json" };
import washiData from "./washi.json" with { type: "json" };
import { themeCss, validateTheme, type Theme } from "./tokens.ts";

function checked(data: unknown, file: string): Theme {
  const { theme, problems } = validateTheme(data);
  if (theme === undefined) throw new Error(`${file}: ${problems.join("; ")}`);
  return theme;
}

export const SUMI: Theme = checked(sumiData, "sumi.json");
export const WASHI: Theme = checked(washiData, "washi.json");

/** The stylesheet's theme rules, from the two themes. */
export const shippedThemeCss = (): string => themeCss(SUMI, WASHI);
