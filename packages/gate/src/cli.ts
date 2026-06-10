#!/usr/bin/env bun
import { dispatch } from "./registry/dispatch";

if (import.meta.main) {
	void dispatch({ rawArgs: process.argv.slice(2) });
}
