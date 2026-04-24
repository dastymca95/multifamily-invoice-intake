"use client";

import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

/**
 * Title bar for catalog editors — owns the catalog name + description
 * inputs in LOCAL state and exposes them to the parent via an
 * imperative ref.
 *
 * Why this exists: the Properties Quality Pass identified
 * state-isolation as the headline performance win for large editable
 * grids. With name/description living up in the parent orchestrator,
 * every keystroke re-rendered the entire grid subtree (potentially
 * thousands of memoized rows + their own internal re-render checks).
 * With the inputs sealed inside this component, a keystroke re-renders
 * only this component's own `<input>` and `<textarea>`. The grid never
 * even re-evaluates.
 *
 * The parent reads name/description only at save time via a ref:
 *
 *     const titleBarRef = useRef<TitleBarHandle>(null);
 *     // …
 *     <IsolatedTitleBar ref={titleBarRef} … />
 *     // …
 *     onSave({ name: titleBarRef.current!.getName().trim(), … })
 *
 * Dirty bubbling: the parent passes an `onTitleDirtyChange` callback;
 * this component computes its own dirty status (name OR description
 * differs from the seed) inside an effect and reports it up. The effect
 * pattern is deliberate — calling the callback inside the change handler
 * would re-render the parent mid-keystroke and partially defeat the
 * isolation.
 *
 * Reset: parents bump `resetCounter` on catalog-switch / discard, which
 * triggers the seed effect to re-pull `initialName` / `initialDescription`.
 *
 * Slots: the bar exposes two render slots so the schema-specific chrome
 * (source badges, draft pills, Save / Discard / Delete buttons) stays
 * with the catalog editor that owns them. The bar itself only knows how
 * to lay out title + description.
 */
export interface TitleBarHandle {
  getName: () => string;
  getDescription: () => string;
  /** Reset to the latest props value (called on discard / catalog switch). */
  reset: () => void;
  /** Best-effort focus the name input. */
  focusName: () => void;
}

export interface IsolatedTitleBarProps {
  initialName: string;
  initialDescription: string;
  /** Right-side content next to the name input (badges, pills). */
  rightSlot?: ReactNode;
  /** Right-aligned action buttons (Save, Discard, Delete). */
  actionsSlot?: ReactNode;
  /** Auto-focus the name input on mount (e.g. for unsaved drafts). */
  autoFocus?: boolean;
  /** Bumped by the parent on catalog switch / discard so the inputs
   * re-seed from the latest props. */
  resetCounter: number;
  /** Bubbles `name !== initialName || description !== initialDescription`
   * to the parent via a separate effect (NOT inline) so the parent
   * doesn't re-render mid-keystroke. */
  onTitleDirtyChange?: (dirty: boolean) => void;
  /** Optional placeholder copy; defaults are catalog-friendly. */
  namePlaceholder?: string;
  descriptionPlaceholder?: string;
  /** Optional cap on the name length (255 is a safe default for our
   * Pydantic schemas). */
  nameMaxLength?: number;
}

export const IsolatedTitleBar = forwardRef<
  TitleBarHandle,
  IsolatedTitleBarProps
>(function IsolatedTitleBar(
  {
    initialName,
    initialDescription,
    rightSlot,
    actionsSlot,
    autoFocus,
    resetCounter,
    onTitleDirtyChange,
    namePlaceholder = "Catalog name",
    descriptionPlaceholder = "Description — what's this catalog for? (optional)",
    nameMaxLength = 255,
  },
  ref,
) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Re-seed when the parent signals a reset.
  useEffect(() => {
    setName(initialName);
    setDescription(initialDescription);
    onTitleDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetCounter]);

  // Bubble dirty up via effect — see the file-level comment for why.
  useEffect(() => {
    if (!onTitleDirtyChange) return;
    const isDirty =
      name.trim() !== initialName.trim() ||
      (description.trim() || null) !== (initialDescription.trim() || null);
    onTitleDirtyChange(isDirty);
  }, [name, description, initialName, initialDescription, onTitleDirtyChange]);

  useImperativeHandle(
    ref,
    () => ({
      getName: () => name,
      getDescription: () => description,
      reset: () => {
        setName(initialName);
        setDescription(initialDescription);
      },
      focusName: () => {
        nameInputRef.current?.focus();
        nameInputRef.current?.select();
      },
    }),
    [name, description, initialName, initialDescription],
  );

  return (
    <div className="px-5 py-3 bg-white border-b">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[14rem]">
          <input
            ref={nameInputRef}
            type="text"
            value={name}
            autoFocus={autoFocus}
            maxLength={nameMaxLength}
            onChange={(e) => setName(e.target.value)}
            placeholder={namePlaceholder}
            className={cn(
              "w-full text-base font-semibold text-gray-900 bg-transparent",
              "border-0 border-b border-transparent hover:border-gray-200",
              "focus:border-brand-500 focus:outline-none px-0 py-1",
            )}
          />
        </div>
        {rightSlot}
        {actionsSlot && (
          <div className="flex items-center gap-1.5 ml-auto">{actionsSlot}</div>
        )}
      </div>
      <textarea
        value={description}
        rows={1}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={descriptionPlaceholder}
        className={cn(
          "w-full mt-1.5 text-[12.5px] text-gray-600 bg-transparent",
          "border-0 resize-none focus:outline-none placeholder:text-gray-400",
        )}
      />
    </div>
  );
});
