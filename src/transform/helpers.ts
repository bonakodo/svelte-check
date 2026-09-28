/** Types for generated checking code. These declarations never run. */
export const HELPERS = String.raw`
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { SvelteHTMLElements as __sv_Elements } from "svelte/elements";
import type { Snippet as __sv_Snippet } from "svelte";
type __sv_Element<K extends string> = K extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[K] : K extends keyof SVGElementTagNameMap ? SVGElementTagNameMap[K] : K extends "svelte:window" ? Window : K extends "svelte:document" ? Document : HTMLElement;
declare function __sv_element<K extends string>(tag: K, attributes: __sv_Elements[K]): __sv_Element<K>;
declare function __sv_dynamic_element<K extends string>(tag: K | null | undefined, attributes: __sv_Elements[K]): __sv_Element<K>;
declare function __sv_each<T>(value: Iterable<T> | ArrayLike<T> | null | undefined): Iterable<T>;
declare function __sv_each_item<T>(value: Iterable<T> | ArrayLike<T> | null | undefined): T;
declare function __sv_await<T>(value: T): Awaited<T>;
declare function __sv_snippet_result(): ReturnType<__sv_Snippet>;
declare function __sv_render_snippet(value: ReturnType<__sv_Snippet> | null | undefined): void;
type __sv_ComponentProps<C> = C extends new (...args: any[]) => { $$prop_def: infer P } ? P : C extends (anchor: any, props: infer P, ...args: any[]) => any ? P : never;
type __sv_ComponentSlots<C> = NonNullable<C> extends { $$slot_def: infer S } ? S : NonNullable<C> extends new (...args: any[]) => { $$slot_def: infer S } ? S : {};
type __sv_CallableComponent<C> = [C] extends [never] ? (anchor: unknown, props: Record<string, unknown>) => {} : C extends new (...args: any[]) => infer I ? (anchor: unknown, props: __sv_ComponentProps<C> & { children?: __sv_Snippet }) => I : C extends { $$slot_def: { default: unknown } } ? (anchor: unknown, props: __sv_ComponentProps<C> & { children?: __sv_Snippet }) => ReturnType<Extract<C, (...args: any[]) => any>> : C;
declare function __sv_component<C extends ((...args: any[]) => any) | (new (...args: any[]) => any) | null | undefined>(component: C): __sv_CallableComponent<NonNullable<C>>;
declare function __sv_component_prop<C, K extends keyof __sv_ComponentProps<C>>(component: C, name: K): __sv_ComponentProps<C>[K];
declare function __sv_component_snippets<C, I>(component: C, instance: I): I extends { $$prop_def: infer P } ? P : __sv_ComponentProps<C>;
declare function __sv_slot<C, K extends keyof __sv_ComponentSlots<C>>(component: C, name: K): __sv_ComponentSlots<C>[K];
type __sv_Keys<T> = T extends unknown ? keyof T : never;
type __sv_SlotUnion<T> = { [K in __sv_Keys<T>]: T extends Record<K, infer V> ? V : undefined };
declare function __sv_slot_union<T extends object>(values: T[]): __sv_SlotUnion<T>;
type __sv_Events<C, I> = I extends { $$events_def: infer E } ? E : NonNullable<C> extends { $$events_def: infer E } ? E : NonNullable<C> extends new (...args: any[]) => { $$events_def: infer E } ? E : "$$events" extends keyof __sv_ComponentProps<C> ? NonNullable<__sv_ComponentProps<C>["$$events"]> : Record<string, CustomEvent<any>>;
declare function __sv_component_event<C, I, K extends keyof __sv_Events<C, I>>(component: C, instance: I, name: K, handler: ((event: __sv_Events<C, I>[K]) => any) | null | undefined): void;
type __sv_Binding<E, K extends string> = K extends "contentRect" ? DOMRectReadOnly : K extends "contentBoxSize" | "borderBoxSize" | "devicePixelContentBoxSize" ? ReadonlyArray<ResizeObserverSize> : K extends keyof E ? E[K] : never;
declare function __sv_binding<E, K extends string>(element: E, name: K): __sv_Binding<E, K>;
declare function __sv_input_value<T extends string>(type: T): T extends "number" | "range" ? number | undefined : string;
declare function __sv_select_value(): any;
declare function __sv_function_bind<T>(value: T, get: (() => NoInfer<T>) | null, set: (value: NoInfer<T>) => void): void;
declare function __sv_store_get<T>(store: { subscribe(run: (value: T) => void): unknown }): T;
declare function __sv_store_settable(store: { set: (...args: any[]) => unknown }): void;
declare function __sv_transition<F extends (...args: any[]) => import("svelte/transition").TransitionConfig | (() => import("svelte/transition").TransitionConfig)>(transition: F, element: Parameters<F>[0], params: Parameters<F>[1]): void;
declare function __sv_action_result(result: void | import("svelte/action").ActionReturn<any, any>): void;
declare function __sv_animation_result(result: import("svelte/animate").AnimationConfig): void;
declare function __sv_attach<E extends EventTarget>(element: E, attachment: import("svelte/attachments").Attachment<NoInfer<E>> | undefined | null | false | 0 | ""): void;
`;
