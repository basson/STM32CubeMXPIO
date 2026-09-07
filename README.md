# STM32CubeMXPIO

VSCode extenstion that generate code from *.ioc file on STM32CubeMX from PlatformIO or Makefile projects.


<img src="https://raw.githubusercontent.com/basson/STM32CubeMXPIO/main/priview/priview_1.png">


# Install and Setting extension

1. Go Preferences (Open Setting UI) -> Workspace -> Extensions -> STM32CubeMXPIO
2. Write STM32CubeMX exec file (absolute path)
3. Other settings are optional

The `*.ioc` file is detected automatically. Set **Project IOC File** only when a
workspace folder contains more than one `*.ioc` file.

The extension activates only in windows whose workspace contains an `*.ioc` file,
and the `STM32CubeMXPio` terminal appears on the first generation - other windows
stay untouched.

In a multi-root workspace every folder is handled on its own: each one can have
its own settings (Preferences -> Folder), the watcher generates into the folder
that owns the changed `*.ioc` file, and the command asks which project to build.


# How it's work

1. Configure you project on STM32CubeMX and save you *.ioc from workspcae dir
2. Setting extenstion (see above)
3. Now run "Command Palette" and write STM32CubeMXPIO:Generate
4. Wait
5. Done

Saving the `*.ioc` file regenerates the project automatically. Turn it off with
the **Auto Generate Project** setting.

# Stm32CubeMX configure project

1. Select the Project Manager -> Project tab
2. In the "Project Name", choose set Toolchain/IDE: Makefile
3. In the Code Generator tab check "Copy only the necessary library files" and "Generate periphery initialization as a pair of '.c/.h' files per peripheral" options


# If extension note generate code

1. Run Stm32Cubemx. If version 6.10 and more authorize
2. Download Firmware Package from your mcu model



---




YouTube Transalations - https://www.youtube.com/@qymistech

Boosty - https://boosty.to/basson_xvi

Patreon - https://www.patreon.com/cw/QymIsTech
