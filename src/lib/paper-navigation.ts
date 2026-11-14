/** Register during HTML parsing so the incoming document stays live during navigation. */
export const PAPER_NAVIGATION_SCRIPT = `(() => {
  const root = document.documentElement;
  let revision = 0;
  addEventListener("pageswap", (event) => {
    const current = ++revision;
    root.style.viewTransitionName = "root";
    const finish = () => {
      if (current === revision) root.style.viewTransitionName = "none";
    };
    if (event.viewTransition) event.viewTransition.finished.then(finish, finish);
    else finish();
  });
  addEventListener("pagereveal", () => {
    revision++;
    root.style.viewTransitionName = "none";
  });
})();`;
