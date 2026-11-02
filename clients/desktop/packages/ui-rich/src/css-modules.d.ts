declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

// After *.module.css on purpose: the first matching wildcard declaration wins.
declare module '*.css';
