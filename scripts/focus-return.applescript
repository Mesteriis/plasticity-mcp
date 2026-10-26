-- Usage: osascript focus-return.applescript PID EXACT_EXECUTABLE WINDOW_TITLE MAX_SECONDS RELEASE_FILE
-- Focus one verified process/window, then restore the previous process/window.
-- Create RELEASE_FILE to return early. No application is launched or closed.
on executableForPID(processPID)
	return do shell script "/bin/ps -p " & quoted form of (processPID as text) & " -o comm="
end executableForPID

on restorePreviousApp(previousPID, previousExecutable, previousWindowName)
	if my executableForPID(previousPID) is not previousExecutable then error "Previous process identity changed; refusing to activate another process."
	tell application "System Events"
		set previousProcess to (first application process whose unix id is previousPID)
		tell previousProcess
			set frontmost to true
			if previousWindowName is not "" then
				set matchingWindows to every window whose name is previousWindowName
				if (count of matchingWindows) is 1 then perform action "AXRaise" of item 1 of matchingWindows
			end if
		end tell
		if unix id of (first application process whose frontmost is true) is not previousPID then error "Previous application did not regain focus."
	end tell
end restorePreviousApp

on run argv
	if (count of argv) is not 5 then error "Expected PID, exact executable, window title, maximum seconds and release file."
	set targetPID to item 1 of argv as integer
	set expectedExecutable to item 2 of argv
	set targetWindowName to item 3 of argv
	set maximumSeconds to item 4 of argv as integer
	set releaseFile to item 5 of argv
	if maximumSeconds < 1 or maximumSeconds > 900 then error "Maximum seconds must be between 1 and 900."
	if releaseFile does not start with "/tmp/" then error "Release file must be task-local under /tmp/."
	if my executableForPID(targetPID) is not expectedExecutable then error "Target process does not match the exact executable."
	try
		do shell script "/bin/test ! -e " & quoted form of releaseFile
	on error
		error "Release file already exists; use a new path."
	end try
	tell application "System Events"
		set previousProcess to (first application process whose frontmost is true)
		set previousPID to unix id of previousProcess
		set previousWindowName to ""
		try
			set previousWindowName to name of front window of previousProcess
		end try
	end tell
	set previousExecutable to my executableForPID(previousPID)
	try
		tell application "System Events"
			set targetProcess to (first application process whose unix id is targetPID)
			tell targetProcess
				set frontmost to true
				repeat 40 times
					set matchingWindows to every window whose name is targetWindowName
					if (count of matchingWindows) is 1 then exit repeat
					delay 0.1
				end repeat
				if (count of matchingWindows) is not 1 then error "Expected exactly one target window after activating its process."
				perform action "AXRaise" of item 1 of matchingWindows
			end tell
			if unix id of (first application process whose frontmost is true) is not targetPID then error "Target application did not gain focus."
		end tell
		log "focused verified target; waiting for release or timeout"
		repeat (maximumSeconds * 4) times
			try
				do shell script "/bin/test -e " & quoted form of releaseFile
				exit repeat
			end try
			delay 0.25
		end repeat
	on error failureMessage number failureNumber
		try
			my restorePreviousApp(previousPID, previousExecutable, previousWindowName)
		on error restoreMessage
			error failureMessage & "; focus restoration also failed: " & restoreMessage number failureNumber
		end try
		error failureMessage number failureNumber
	end try
	my restorePreviousApp(previousPID, previousExecutable, previousWindowName)
	return "returned to previous application"
end run
