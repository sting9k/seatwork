import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Children } from "react";
import { Pressable, Text, View } from "react-native";

export type Colors = PluginTheme["colors"];
/** What a component is given to draw inside itself; React is the host's, typed loosely here. */
export type Inside = unknown;

/** A part of the screen: its name, one line on what it decides, then its card. */
export function Part(props: { title: string; note?: string; colors: Colors; children: Inside }) {
  const { title, note, colors: c, children } = props;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ gap: 3, paddingHorizontal: 2 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
        {note ? <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{note}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/** A bordered group of rows with a line between them. */
export function Card(props: { colors: Colors; border?: string; children: Inside }) {
  const { colors: c, border, children } = props;
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={{ backgroundColor: c.surface1, borderColor: border ?? c.border, borderWidth: 1, borderRadius: 12 }}>
      {rows.map((row: Inside, index: number) => (
        <View key={index} style={index > 0 ? { borderTopWidth: 1, borderTopColor: c.border } : null}>{row}</View>
      ))}
    </View>
  );
}

/** One row of a card: a name, what it is now, and what can be done with it on the right. A press opens it. */
export function Line(props: { name: string; value?: string; note?: string; icon?: string; right?: Inside; onPress?(): void; colors: Colors; nameWidth?: number; /** A field's label, as the settings rows beside it write theirs. */ field?: boolean }) {
  const { name, value, note, icon, right, onPress, colors: c, nameWidth, field } = props;
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13, paddingHorizontal: 16 }}>
      {icon ? <Icon name={icon} size={16} color={c.foregroundMuted} /> : null}
      <View style={nameWidth ? { width: nameWidth } : { flex: value === undefined ? 1 : 0 }}>
        <Text numberOfLines={nameWidth ? 1 : undefined} style={{ color: c.foreground, fontSize: 14, fontWeight: field ? "400" : "600" }}>{name}</Text>
        {note && nameWidth === undefined ? <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, marginTop: 2 }}>{note}</Text> : null}
      </View>
      {value !== undefined ? (
        <View style={{ flex: 1 }}>
          <Text numberOfLines={3} style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{value}</Text>
          {note && nameWidth !== undefined ? <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, marginTop: 2 }}>{note}</Text> : null}
        </View>
      ) : null}
      {right}
      {onPress ? <Icon name="ChevronRight" size={16} color={c.foregroundMuted} /> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={value ? `${name}: ${value}` : name} onPress={onPress}>
      {body}
    </Pressable>
  );
}

/** primary: the one thing this part is for. danger: it takes something away. */
export function Button(props: { label: string; onPress(): void; kind?: "primary" | "plain" | "danger"; disabled?: boolean; colors: Colors }) {
  const { label, onPress, kind = "plain", disabled, colors: c } = props;
  const filled = kind === "primary";
  const edge = filled ? c.accent : kind === "danger" ? c.statusDanger : c.border;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{ paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: edge, backgroundColor: filled ? c.accent : "transparent", opacity: disabled ? 0.45 : 1 }}
    >
      <Text style={{ color: filled ? c.accentForeground : kind === "danger" ? c.statusDanger : c.foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** A short word about a row: its state, or that it differs from what is underneath. */
export function Pill(props: { text: string; color?: string; colors: Colors }) {
  const color = props.color ?? props.colors.foregroundMuted;
  return (
    <View style={{ paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: color }}>
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{props.text}</Text>
    </View>
  );
}

/** A line of plain words inside a card. */
export function Note(props: { text: string; color?: string; colors: Colors }) {
  return <Text style={{ color: props.color ?? props.colors.foregroundMuted, fontSize: 12, lineHeight: 18, paddingVertical: 11, paddingHorizontal: 16 }}>{props.text}</Text>;
}
