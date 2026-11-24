## Connect your issue tracker

**Public repositories on github.com or gitlab.com need no setup.** The tracker is found from your Git remote.

Add a token when:

- the repository is **private**;
- you use **GitHub without a token** often (the limit is 60 requests an hour; a token raises it to 5,000);
- the tracker is **self-hosted** (GitHub Enterprise or self-managed GitLab).

Run **Issue Commit: Set Issue Platform Token…**. A read-only token is enough:
GitHub fine-grained token with *Issues: Read*, or a GitLab token with `read_api`.

Self-hosted tracker, or issues kept in a different repository?
Run **Issue Commit: Configure Issue Search for This Project…** to add it.
