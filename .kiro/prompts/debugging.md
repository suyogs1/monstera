Debug: $ARGUMENTS

Work in this order and show each step's evidence:

1. **Reproduce.** Run the failing command and show its exact command line and output (or the CI
   run id and the failing step's log excerpt). If it doesn't reproduce, say so and stop.
2. **Locate.** Narrow it to the smallest input, file and line. Read the code before claiming
   anything about it.
3. **Hypothesis.** State one root-cause hypothesis and the observation that would confirm or
   refute it. Check it.
4. **Fix.** Change one thing at a time. For generated output, fix the template/spec/engine and
   regenerate; never patch generated files.
5. **Prove.** Add a regression test that fails before the fix and passes after. Run `monstera gates`.
6. **Stop rule.** After two failed fix attempts, stop patching: report what was tried, why it
   failed, and a fundamentally different approach.

Output:
- `Repro:` command + output
- `Root cause:` one paragraph
- `Fix:` files and change
- `Regression test:` name, with fail-before/pass-after evidence
- `Gates:` output
