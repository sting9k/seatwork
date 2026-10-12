import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";

export type Colors = PluginTheme["colors"];
/** What a component is given to draw inside itself; React is the host's, typed loosely here. */
export type Inside = unknown;
type Style = Record<string, unknown>;

/** A theme colour at part of its strength, for a wash behind text or a quiet line. */
export function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color.startsWith("rgb(") ? color.replace("rgb(", "rgba(").replace(")", `, ${alpha})`) : color;
  const full = hex.length === 3 ? [...hex].map((ch) => ch + ch).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The mark of each agent CLI: a seat's model reads at a glance by whose it is. */
export const CLI_COLOR: Record<string, string> = { claude: "#D97757", codex: "#6FA8F5", pi: "#B08CF5", opencode: "#E0B84C" };

/** A bordered block of the screen. */
export function Card(props: { colors: Colors; style?: Style; children: Inside }) {
  const c = props.colors;
  return <View style={{ backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 14, ...props.style }}>{props.children}</View>;
}

/** A card's name and one line on what it holds. */
export function CardHead(props: { title: string; count?: number; sub?: Inside; right?: Inside; colors: Colors }) {
  const c = props.colors;
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 16, paddingTop: 18, paddingHorizontal: 20, paddingBottom: 14 }}>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 15, lineHeight: 20, fontWeight: "600" }}>{props.title}</Text>
          {props.count !== undefined ? <Badge text={String(props.count)} colors={c} /> : null}
        </View>
        {props.sub ? <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{props.sub}</Text> : null}
      </View>
      {props.right}
    </View>
  );
}

/** A small rounded square that carries an icon: a role, a section. */
export function IconTile(props: { icon: string; colors: Colors; size?: number; fill?: string; color?: string }) {
  const size = props.size ?? 32;
  return (
    <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), backgroundColor: props.fill ?? tint(props.colors.foreground, 0.08), alignItems: "center", justifyContent: "center" }}>
      <Icon name={props.icon} size={Math.round(size / 2)} color={props.color ?? props.colors.foreground} />
    </View>
  );
}

export function Dot(props: { color: string; size?: number }) {
  const size = props.size ?? 8;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: props.color }} />;
}

/** How many of a meter's three bars a thinking level fills. */
const BARS: Record<string, number> = { off: 0, none: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 3, max: 3, ultracode: 3 };

/** A thinking level as three rising bars. */
export function Meter(props: { level: string; colors: Colors }) {
  const on = BARS[props.level] ?? 2;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 10 }}>
      {[5, 7.5, 10].map((height, index) => (
        <View key={height} style={{ width: 3, height, borderRadius: 1, backgroundColor: index < on ? props.colors.statusSuccess : tint(props.colors.foreground, 0.2) }} />
      ))}
    </View>
  );
}

/**
 * A model in a seat: whose it is, its name, how hard it thinks. `was` is what applying replaces,
 * `new` what it puts there, `gone` a model taken out.
 */
export function Chip(props: { cli?: string; model: string; thinking?: string; tone?: "was" | "new" | "gone"; /** One width for a column of chips. */ width?: number; /** Takes the room its row has left. */ grow?: boolean; colors: Colors }) {
  const { cli, model, thinking, tone, width, grow, colors: c } = props;
  const spread = Boolean(width) || Boolean(grow);
  const faint = tone === "was" || tone === "gone";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        height: 28,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: faint ? "dashed" : "solid",
        borderColor: tone === "new" ? c.statusWarning : tint(c.foreground, 0.16),
        backgroundColor: faint ? "transparent" : c.surface0,
        opacity: tone === "was" ? 0.75 : 1,
        ...(grow ? { flex: 1 } : width ? { width } : {}),
      }}
    >
      {cli ? <Dot color={CLI_COLOR[cli] ?? c.foregroundMuted} /> : null}
      <Text numberOfLines={1} style={{ color: faint ? c.foregroundMuted : c.foreground, fontSize: 13, lineHeight: 18, fontWeight: faint ? "400" : "500", textDecorationLine: tone === "was" ? "line-through" : "none", flexShrink: 1 }}>{model}</Text>
      {thinking && !faint ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginLeft: spread ? "auto" : 0 }}>
          <View style={{ width: 1, height: 12, backgroundColor: tint(c.foreground, 0.16) }} />
          <Meter level={thinking} colors={c} />
          <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{thinking}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** A short word about a row: whose table it follows, how many there are. */
export function Badge(props: { text: string; tone?: "own" | "warn"; colors: Colors }) {
  const c = props.colors;
  const color = props.tone === "own" ? c.statusSuccess : props.tone === "warn" ? c.statusWarning : c.foregroundMuted;
  return (
    <View style={{ height: 22, paddingHorizontal: 9, borderRadius: 999, justifyContent: "center", backgroundColor: tint(props.tone ? color : c.foreground, props.tone ? 0.16 : 0.08) }}>
      <Text style={{ color, fontSize: 11.5, lineHeight: 16, fontWeight: "500" }}>{props.text}</Text>
    </View>
  );
}

/** primary: the one thing this card is for. danger: it takes something away. */
export function Btn(props: { label: string; onPress(): void; kind?: "primary" | "plain" | "danger"; disabled?: boolean; grow?: boolean; colors: Colors }) {
  const { label, onPress, kind = "plain", disabled, grow, colors: c } = props;
  const filled = kind === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{ height: 32, paddingHorizontal: 14, borderRadius: 9, borderWidth: 1, alignItems: "center", justifyContent: "center", borderColor: filled ? c.accent : kind === "danger" ? c.statusDanger : tint(c.foreground, 0.16), backgroundColor: filled ? c.accent : "transparent", opacity: disabled ? 0.4 : 1, ...(grow ? { flex: 1 } : {}) }}
    >
      <Text style={{ color: filled ? c.accentForeground : kind === "danger" ? c.statusDanger : c.foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** One choice out of a few, all in view; more than fit on a line wrap to the next. */
export function Seg<Value extends string>(props: { options: readonly { label: string; value: Value }[]; value: Value; onChange(value: Value): void; colors: Colors }) {
  const c = props.colors;
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 2, padding: 3, borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0 }}>
      {props.options.map((option) => {
        const on = option.value === props.value;
        return (
          <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ selected: on }} onPress={() => props.onChange(option.value)} style={{ flexGrow: 1, height: 26, paddingHorizontal: 10, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: on ? tint(c.foreground, 0.1) : "transparent" }}>
            <Text numberOfLines={1} style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: 12.5, fontWeight: "500" }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Toggle(props: { value: boolean; onChange(value: boolean): void; label: string; colors: Colors }) {
  const c = props.colors;
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={props.label} accessibilityState={{ checked: props.value }} onPress={() => props.onChange(!props.value)} style={{ width: 36, height: 22, borderRadius: 11, padding: 2, justifyContent: "center", alignItems: props.value ? "flex-end" : "flex-start", backgroundColor: props.value ? c.accent : tint(c.foreground, 0.2) }}>
      <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: "#FAFAFA" }} />
    </Pressable>
  );
}

/** A label and its value on one line of a rail card. */
export function KeyValue(props: { name: string; icon?: string; value?: string; mono?: boolean; right?: Inside; colors: Colors }) {
  const c = props.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {props.icon ? <Icon name={props.icon} size={13} color={c.foregroundMuted} /> : null}
      <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{props.name}</Text>
      {props.value !== undefined ? <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, lineHeight: 17, fontWeight: "500", flexShrink: 1, ...(props.mono ? { fontFamily: "monospace" } : {}) }}>{props.value}</Text> : null}
      {props.right}
    </View>
  );
}

/** Text that acts: a quiet link under a card, a way back. */
export function Link(props: { label: string; icon?: string; onPress(): void; color?: string; colors: Colors }) {
  const color = props.color ?? props.colors.foregroundMuted;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress} style={{ flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start" }}>
      {props.icon ? <Icon name={props.icon} size={14} color={color} /> : null}
      <Text style={{ color, fontSize: 12.5, lineHeight: 18 }}>{props.label}</Text>
    </Pressable>
  );
}
