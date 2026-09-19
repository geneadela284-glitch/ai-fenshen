import { theme } from '../theme/tokens';

function PrimaryButton({ children, variant = 'dark', className = '', ...props }) {
  const styles = variant === 'dark' ? theme.darkButton : theme.lightButton;
  return (
    <button className={`${styles} disabled:cursor-not-allowed disabled:opacity-50 ${className}`} {...props}>
      {children}
    </button>
  );
}

export default PrimaryButton;
