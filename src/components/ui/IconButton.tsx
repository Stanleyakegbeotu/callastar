import type { ButtonHTMLAttributes } from "react";

import { Icon, type IconName } from "./Icon";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  icon: IconName;
  /** Required: these controls never carry visible text of their own. */
  label: string;
  /** Dark filled treatment, used for on/muted states. */
  active?: boolean;
  danger?: boolean;
  /** Set for on/off controls so assistive tech reads the state, not just the icon. */
  pressed?: boolean;
  className?: string;
  iconClassName?: string;
}

export function IconButton({
  icon,
  label,
  active = false,
  danger = false,
  pressed,
  className = "",
  iconClassName = "size-6",
  ...rest
}: IconButtonProps) {
  const classes = ["control-button", active ? "control-active" : "", danger ? "control-danger" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" className={classes} aria-label={label} aria-pressed={pressed} {...rest}>
      <Icon name={icon} className={iconClassName} />
    </button>
  );
}

export default IconButton;
