# faq

Tags: fluent, development, general

FAQ

Answers to frequently asked questions about developing apps with Fluent and the ServiceNow SDK.


Q: Can Fluent execute design-time workflows (UI policies, client scripts, business rules, auto-incrementing fields, etc.) from the platform UI?

A: No. Fluent does not and will never have parity with the platform's dynamic editing surfaces. Forms and builder UIs (like Flow Designer) drive design-time behavior based on user sessions, database queries, etc. Fluent is a static programming language that lives in a text editor.

These are two distinct paradigms with their own unique characteristics:
• The platform UI is designed for maximum convenience and simplicity.
• Fluent is designed for maximum control and power.

We can (and do) provide a lot of design-time conveniences and feedback via a combination of TypeScript types (which power the Fluent APIs) and diagnostics from the Fluent compiler. For use cases where you find the platform UI to be preferable, you are free to do your development there and sync your changes to the Fluent code using the transform command.
