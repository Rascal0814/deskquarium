' Start Deskquarium without a console window.
' Run "npm install" in this folder once before first use.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
' 0 = hidden window, False = do not wait
sh.Run "node """ & here & "\scripts\launch.js""", 0, False
