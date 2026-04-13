"use client";

import { useState } from "react";
import type { CSSProperties } from "react";

export interface PasswordInputProps {
  id: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function PasswordInput({
  id,
  value,
  onChange,
  required,
  className,
  style,
}: PasswordInputProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <input
        id={id}
        type={showPassword ? "text" : "password"}
        className={className}
        value={value}
        onChange={onChange}
        required={required}
        style={{ ...style, paddingRight: 40 }}
      />
      <button
        type="button"
        onClick={() => setShowPassword((p) => !p)}
        aria-label={showPassword ? "Hide password" : "Show password"}
        style={{
          position: "absolute",
          right: 8,
          top: "50%",
          transform: "translateY(-50%)",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 4,
          fontSize: 18,
          color: "var(--text-muted, #999)",
          lineHeight: 1,
        }}
      >
        {showPassword ? "\u{1F648}" : "\u{1F441}"}
      </button>
    </div>
  );
}
