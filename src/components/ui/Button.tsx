import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Icon } from "./Icon";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  children: ReactNode;
  /** `secondary` is the quieter outline treatment used beside a primary action. */
  variant?: "primary" | "secondary";
  /** The design puts a trailing arrow on forward actions; off for everything else. */
  withArrow?: boolean;
  className?: string;
}

export function Button({
  children,
  variant = "primary",
  withArrow = true,
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  const variantClass = variant === "secondary" ? "secondary-button" : "primary-button";

  return (
    <button type={type} className={`${variantClass} ${className}`.trim()} {...rest}>
      <span>{children}</span>
      {withArrow && <Icon name="arrow" className="size-5" />}
    </button>
  );
}

export default Button;
