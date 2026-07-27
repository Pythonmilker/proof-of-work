# Genestrata

Unity / C# game project. Not currently in the capability record — this file is here so a live ingest has
something genuinely new to find.

## What it is

A game built around data-driven content: creatures, items, and encounters are all authored as Unity
ScriptableObjects rather than hardcoded, so the content layer can be edited without touching the code
that consumes it.

## Stack

- Unity, C#
- ScriptableObject-driven content pipeline
- Three.js / React-Three-Fiber for the web-facing pieces
- A structured AI art-generation pipeline feeding the asset library

## Notes

Local only. No public build, no store listing, no live URL. The art pipeline is the interesting part:
prompts and post-processing steps are versioned alongside the assets they produce, so a regenerated
asset is reproducible rather than a one-off.

Status: in development.
