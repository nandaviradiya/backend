import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AiService, ScoreFeaturesDto, ExplainRequestDto } from './ai.service';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('score')
  @ApiOperation({ summary: 'Predict follow-through probability & quality score for candidate breakout' })
  score(@Body() features: ScoreFeaturesDto) {
    return this.aiService.scoreSignal(features);
  }

  @Post('explain')
  @ApiOperation({ summary: 'Generate structured AI reasoning and pros/cons for trade signal' })
  explain(@Body() data: ExplainRequestDto) {
    return this.aiService.explainSignal(data);
  }
}
