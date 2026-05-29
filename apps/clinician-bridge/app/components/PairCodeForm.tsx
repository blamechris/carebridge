"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const CODE_LENGTH = 6;
const VALID_CHAR = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]$/;

export function PairCodeForm() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function normalize(raw: string): string {
    return raw
      .toUpperCase()
      .split("")
      .filter((c) => VALID_CHAR.test(c))
      .join("")
      .slice(0, CODE_LENGTH);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (code.length !== CODE_LENGTH) {
      setError(`Code must be ${CODE_LENGTH} characters.`);
      return;
    }
    router.push(`/session/${code}`);
  }

  return (
    <form className="pair-form" onSubmit={onSubmit} aria-label="Enter pairing code">
      <label htmlFor="pair-code" className="pair-form__label">
        6-character code
      </label>
      <input
        id="pair-code"
        name="code"
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(normalize(e.target.value))}
        placeholder="ABCD23"
        maxLength={CODE_LENGTH}
        className="pair-form__input"
        aria-describedby={error ? "pair-error" : undefined}
      />
      <button
        type="submit"
        className="pair-form__submit"
        disabled={code.length !== CODE_LENGTH}
      >
        Open capture
      </button>
      {error ? (
        <p id="pair-error" className="pair-form__error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
