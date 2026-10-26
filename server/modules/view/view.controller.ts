import { Controller, Get, Render, Req } from '@nestjs/common';
import type { Request } from 'express';

const APP_BROWSER_TITLE = '世纪互联-南通基地';
const APP_FAVICON_PATH = '/favicon.svg?v=20260815';

@Controller()
export class ViewController {
  @Get('/overtime-confirmation')
  @Render('overtime-confirmation/index')
  async renderOvertimeConfirmation(@Req() req: Request) {
    return this.render(req);
  }

  @Get(['/', '*'])
  @Render('index')
  async render(@Req() req: Request) {
    // you can add custom render params here
    const platformData = {
      ...(req.__platform_data__ ?? {}),
      appName: APP_BROWSER_TITLE,
      appDescription: APP_BROWSER_TITLE,
      appAvatar: APP_FAVICON_PATH,
      showBadge: false,
    };
    return {
      // don't delete this line, it's used by client to get platform info
      __platform__: JSON.stringify(platformData),
      appName: APP_BROWSER_TITLE,
      appDescription: APP_BROWSER_TITLE,
      appAvatar: APP_FAVICON_PATH,
      showBadge: false,
    };
  }
}
