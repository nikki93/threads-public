import type * as types from '../_types';

export const IconButton: typeof types.IconButton = ({
  title,
  onClick,
  children,
  disabled = false,
  active = false,
}): JSX.Element => (
  <button
    className={`icon-btn${active ? ' on' : ''}`}
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={disabled}>
    {children}
  </button>
);
