import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateOrderItemDto {
  @IsUUID()
  productId: string;

  @IsInt()
  @Min(1)
  @Max(99)
  quantity: number;
}

/**
 * Ojo: el cliente NO manda precios ni total. El servidor los calcula desde la base de datos.
 * Si el total viniera del front, cualquiera podría pagar $1 por un pedido de $100.000.
 */
export class CreateOrderDto {
  @IsEmail()
  customerEmail: string;

  @IsString()
  @MinLength(5)
  @MaxLength(300)
  shippingAddress: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}
