# STM32CubeMXPIO

VSCode extenstion that generate code from *.ioc file on STM32CubeMX from PlatformIO or Makefile projects.


<img src="https://raw.githubusercontent.com/basson/STM32CubeMXPIO/main/priview/priview_1.png">


# Install and Setting extension

1. Go Preferences (Open Setting UI) -> Workspace -> Extensions -> STM32CubeMXPIO
2. Write Project IOCFile (example.ioc)
3. Write STM32CubeMX exec file (absolute path)
4. Other settings are optional


# How it's work

1. Configure you project on STM32CubeMX and save you *.ioc from workspcae dir
2. Setting extenstion (see above)
3. Now run "Command Palette" and write STM32CubeMXPIO:Generate
4. Wait
5. Done

# Stm32CubeMX configure project

1. Select the Project Manager -> Project tab
2. In the "Project Name", choose set Toolchain/IDE: Makefile
3. In the Code Generator tab check "Copy only the necessary library files" and "Generate periphery initialization as a pair of '.c/.h' files per peripheral" options


# If extension note generate code

1. Run Stm32Cubemx. If version 6.10 and more authorize
2. Download Firmware Package from your mcu model



---



**Подписывайся на мой youtube канал я там стараюсь вести регулярные стримы по всем своим проектам!!**

YouTube Transalations - https://www.youtube.com/@basson_xvi/streams

Thingiverse - https://www.thingiverse.com/thing:6427349

Printables - https://www.printables.com/model/716319-flying-bear-ghost-6-slim-skirt-for-electronics-pla

[![](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/basson)