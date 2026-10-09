// file: frontend/src/components/ui/sort.tsx
import { ArrowUpDown } from "lucide-react";
import { IconButton } from "./button";
import { Menu, MenuItem } from "./menu";

export interface SortOption<T extends string = string> {
  value: T;
  label: string;
}

export interface SortMenuProps<T extends string = string> {
  /** Tooltip prefix. The current option is appended. */
  label: string;
  value: T;
  options: readonly SortOption<T>[];
  onChange: (value: T) => void;
}

/** One button, one menu, a check on the current option. */
export function SortMenu<T extends string>({ label, value, options, onChange }: SortMenuProps<T>) {
  const current = options.find((option) => option.value === value)?.label;
  return (
    <Menu
      label={label}
      trigger={
        <IconButton
          label={current ? `${label}: ${current}` : label}
          icon={<ArrowUpDown size={18} />}
        />
      }
    >
      {options.map((option) => (
        <MenuItem
          key={option.value}
          checked={option.value === value}
          onSelect={() => onChange(option.value)}
        >
          {option.label}
        </MenuItem>
      ))}
    </Menu>
  );
}
