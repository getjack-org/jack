"use client";

import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Carousel,
	CarouselContent,
	CarouselItem,
	CarouselNext,
	CarouselPrevious,
} from "@/components/ui/carousel";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSeparator,
	InputOTPSlot,
} from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import {
	Pagination,
	PaginationContent,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@/components/ui/pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	AlertCircle,
	AlignCenter,
	AlignLeft,
	AlignRight,
	Archive,
	ArrowLeft,
	Bell,
	Bold,
	CalendarIcon,
	Check,
	ChevronsUpDown,
	Cloud,
	Copy,
	CreditCard,
	FileText,
	Flag,
	Home,
	Info,
	Italic,
	Laptop,
	Loader2,
	Mail,
	Minus,
	Monitor,
	Moon,
	MoreHorizontal,
	Plus,
	Search,
	Settings,
	Sun,
	Terminal,
	Underline,
	User,
} from "lucide-react";
import { useState } from "react";

export function ComponentShowcase() {
	const [sliderValue, setSliderValue] = useState([400]);
	const [gpuCount, setGpuCount] = useState(8);
	const [copied, setCopied] = useState(false);
	const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
	const [collapsibleOpen, setCollapsibleOpen] = useState(false);

	return (
		<div className="columns-1 gap-4 sm:columns-2 lg:columns-3 xl:columns-4 [&>*]:mb-4 [&>*]:break-inside-avoid">
			{/* Payment Form */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Payment Method</CardTitle>
					<p className="text-sm text-muted-foreground">
						All transactions are secure and encrypted.
					</p>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-1">
						<Label>Name on Card</Label>
						<Input defaultValue="John Doe" />
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1">
							<Label>Card Number</Label>
							<Input placeholder="1234 5678 9012 3456" />
						</div>
						<div className="space-y-1">
							<Label>CVV</Label>
							<Input placeholder="123" />
						</div>
					</div>
					<p className="text-xs text-muted-foreground">Enter your 16-digit number.</p>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1">
							<Label>Month</Label>
							<Select>
								<SelectTrigger>
									<SelectValue placeholder="MM" />
								</SelectTrigger>
								<SelectContent>
									{Array.from({ length: 12 }, (_, i) => (
										<SelectItem key={i + 1} value={String(i + 1).padStart(2, "0")}>
											{String(i + 1).padStart(2, "0")}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1">
							<Label>Year</Label>
							<Select>
								<SelectTrigger>
									<SelectValue placeholder="YYYY" />
								</SelectTrigger>
								<SelectContent>
									{[2025, 2026, 2027, 2028, 2029].map((y) => (
										<SelectItem key={y} value={String(y)}>
											{y}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					<Separator />
					<div>
						<h4 className="mb-1 font-medium text-sm">Billing Address</h4>
						<p className="text-xs text-muted-foreground">
							The billing address associated with your payment method
						</p>
					</div>
					<div className="flex items-center gap-2">
						<Checkbox id="same-address" defaultChecked />
						<Label htmlFor="same-address">Same as shipping address</Label>
					</div>
					<Separator />
					<div className="space-y-1">
						<Label>Comments</Label>
						<Textarea placeholder="Add any additional comments" />
					</div>
					<div className="flex gap-2">
						<Button className="flex-1">Submit</Button>
						<Button variant="outline" className="flex-1">
							Cancel
						</Button>
					</div>
				</CardContent>
			</Card>

			{/* Status Badges & Chat */}
			<Card>
				<CardContent className="space-y-4 pt-6">
					<div className="flex items-center justify-center gap-2">
						<Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
							<span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-500 animate-pulse" />
							Syncing
						</Badge>
						<Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">
							<span className="mr-1 inline-block size-1.5 rounded-full bg-blue-500 animate-pulse" />
							Updating
						</Badge>
						<Badge className="bg-orange-500/10 text-orange-500 border-orange-500/20">
							<span className="mr-1 inline-block size-1.5 rounded-full bg-orange-500 animate-pulse" />
							Loading
						</Badge>
					</div>
					<div className="rounded-lg border p-3">
						<div className="flex items-center gap-2">
							<Button variant="ghost" size="icon" className="size-8">
								<Plus className="size-4" />
							</Button>
							<span className="flex-1 text-sm text-muted-foreground">Send a message...</span>
							<Button variant="ghost" size="icon" className="size-8">
								<ArrowLeft className="size-4 rotate-90" />
							</Button>
						</div>
					</div>
					<div>
						<h4 className="font-medium text-sm">Price Range</h4>
						<p className="text-xs text-muted-foreground mb-3">
							Set your budget range (${sliderValue[0]} - $800).
						</p>
						<Slider defaultValue={[200, 800]} max={1000} step={50} onValueChange={setSliderValue} />
					</div>
					<div className="flex items-center gap-2 rounded-lg border px-3 py-2">
						<Search className="size-4 text-muted-foreground" />
						<span className="flex-1 text-sm text-muted-foreground">Search...</span>
						<span className="text-xs text-muted-foreground">12 results</span>
					</div>
					<div className="flex items-center gap-2 rounded-lg border px-3 py-2">
						<span className="flex-1 text-sm text-muted-foreground truncate">
							https:// example.com
						</span>
						<Button
							variant="ghost"
							size="icon"
							className="size-7"
							onClick={() => {
								setCopied(true);
								setTimeout(() => setCopied(false), 2000);
							}}
						>
							{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
						</Button>
					</div>
					<div className="rounded-lg border p-3 space-y-2">
						<Textarea
							placeholder="Ask, Search or Chat..."
							className="border-0 p-0 shadow-none resize-none focus-visible:ring-0"
							rows={2}
						/>
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-1">
								<Button variant="ghost" size="icon" className="size-7">
									<Plus className="size-4" />
								</Button>
								<span className="text-xs text-muted-foreground">Auto</span>
							</div>
							<div className="flex items-center gap-2">
								<span className="text-xs text-muted-foreground">52% used</span>
								<Button size="icon" className="size-7 rounded-full">
									<ArrowLeft className="size-3 rotate-90" />
								</Button>
							</div>
						</div>
					</div>
					<div className="flex items-center gap-2 rounded-lg border px-3 py-2">
						<span className="text-sm">@shadcn</span>
						<Check className="ml-auto size-4 text-blue-500" />
					</div>
				</CardContent>
			</Card>

			{/* Compute Environment (Radio Group) */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Compute Environment</CardTitle>
					<p className="text-sm text-muted-foreground">
						Select the compute environment for your cluster.
					</p>
				</CardHeader>
				<CardContent className="space-y-4">
					<RadioGroup defaultValue="kubernetes">
						<div className="flex items-start gap-3 rounded-lg border p-3 data-[state=checked]:border-primary">
							<RadioGroupItem value="kubernetes" id="k8s" className="mt-0.5" />
							<div>
								<Label htmlFor="k8s" className="font-medium">
									Kubernetes
								</Label>
								<p className="text-xs text-muted-foreground">
									Run GPU workloads on a K8s configured cluster. This is the default.
								</p>
							</div>
						</div>
						<div className="flex items-start gap-3 rounded-lg border p-3">
							<RadioGroupItem value="vm" id="vm" className="mt-0.5" />
							<div>
								<Label htmlFor="vm" className="font-medium">
									Virtual Machine
								</Label>
								<p className="text-xs text-muted-foreground">
									Access a VM configured cluster to run workloads. (Coming soon)
								</p>
							</div>
						</div>
					</RadioGroup>
					<Separator />
					<div className="flex items-center justify-between">
						<div>
							<h4 className="font-medium text-sm">Number of GPUs</h4>
							<p className="text-xs text-muted-foreground">You can add more later.</p>
						</div>
						<div className="flex items-center gap-1">
							<Input className="w-14 text-center" value={gpuCount} readOnly />
							<Button
								variant="outline"
								size="icon"
								className="size-8"
								onClick={() => setGpuCount(Math.max(1, gpuCount - 1))}
							>
								<Minus className="size-3" />
							</Button>
							<Button
								variant="outline"
								size="icon"
								className="size-8"
								onClick={() => setGpuCount(gpuCount + 1)}
							>
								<Plus className="size-3" />
							</Button>
						</div>
					</div>
					<Separator />
					<div className="flex items-center justify-between">
						<div>
							<h4 className="font-medium text-sm">Wallpaper Tinting</h4>
							<p className="text-xs text-muted-foreground">Allow the wallpaper to be tinted.</p>
						</div>
						<Switch defaultChecked />
					</div>
				</CardContent>
			</Card>

			{/* Actions Bar */}
			<Card>
				<CardContent className="space-y-4 pt-6">
					<div className="flex items-center gap-1">
						<Button variant="outline" size="icon" className="size-8">
							<ArrowLeft className="size-4" />
						</Button>
						<div className="flex flex-1 items-center gap-1 justify-end">
							<Button variant="outline" size="sm">
								Archive
							</Button>
							<Button variant="outline" size="sm">
								Report
							</Button>
							<Button variant="outline" size="sm">
								Snooze
							</Button>
							<Button variant="outline" size="icon" className="size-8">
								<MoreHorizontal className="size-4" />
							</Button>
						</div>
					</div>
					<div className="flex items-center gap-2">
						<Checkbox id="terms" defaultChecked />
						<Label htmlFor="terms">I agree to the terms and conditions</Label>
					</div>
					<Separator className="relative">
						<span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
							Appearance Settings
						</span>
					</Separator>
					<Pagination>
						<PaginationContent>
							<PaginationItem>
								<PaginationPrevious href="#" />
							</PaginationItem>
							<PaginationItem>
								<PaginationLink href="#" isActive>
									1
								</PaginationLink>
							</PaginationItem>
							<PaginationItem>
								<PaginationLink href="#">2</PaginationLink>
							</PaginationItem>
							<PaginationItem>
								<PaginationLink href="#">3</PaginationLink>
							</PaginationItem>
							<PaginationItem>
								<PaginationNext href="#" />
							</PaginationItem>
						</PaginationContent>
					</Pagination>
				</CardContent>
			</Card>

			{/* Survey Toggle Group */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">How did you hear about us?</CardTitle>
					<p className="text-sm text-muted-foreground">Select the option that best describes...</p>
				</CardHeader>
				<CardContent className="space-y-4">
					<ToggleGroup type="single" defaultValue="social" className="flex-wrap">
						<ToggleGroupItem value="social" className="gap-1">
							<Check className="size-3" />
							Social Media
						</ToggleGroupItem>
						<ToggleGroupItem value="search">Search Engine</ToggleGroupItem>
						<ToggleGroupItem value="referral">Referral</ToggleGroupItem>
						<ToggleGroupItem value="other">Other</ToggleGroupItem>
					</ToggleGroup>
					<Separator />
					<div className="flex flex-col items-center gap-2 py-4">
						<Spinner className="size-6" />
						<h4 className="font-medium text-sm">Processing your request</h4>
						<p className="text-xs text-muted-foreground text-center">
							Please wait while we process your request. Do not refresh the page.
						</p>
						<Button variant="outline" size="sm" className="mt-1">
							Cancel
						</Button>
					</div>
				</CardContent>
			</Card>

			{/* Text Formatting Toolbar */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Text Formatting</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="flex items-center gap-1">
						<Toggle size="sm" aria-label="Bold" defaultPressed>
							<Bold className="size-4" />
						</Toggle>
						<Toggle size="sm" aria-label="Italic">
							<Italic className="size-4" />
						</Toggle>
						<Toggle size="sm" aria-label="Underline">
							<Underline className="size-4" />
						</Toggle>
						<Separator orientation="vertical" className="mx-1 h-6" />
						<ToggleGroup type="single" defaultValue="left">
							<ToggleGroupItem value="left" size="sm">
								<AlignLeft className="size-4" />
							</ToggleGroupItem>
							<ToggleGroupItem value="center" size="sm">
								<AlignCenter className="size-4" />
							</ToggleGroupItem>
							<ToggleGroupItem value="right" size="sm">
								<AlignRight className="size-4" />
							</ToggleGroupItem>
						</ToggleGroup>
					</div>
					<ToggleGroup type="single" defaultValue="copilot" className="justify-start">
						<ToggleGroupItem value="copilot" className="gap-1 text-xs">
							<Cloud className="size-3" /> Copilot
						</ToggleGroupItem>
						<ToggleGroupItem value="local" className="gap-1 text-xs">
							<Monitor className="size-3" /> Local
						</ToggleGroupItem>
					</ToggleGroup>
				</CardContent>
			</Card>

			{/* Team Members */}
			<Card>
				<CardContent className="space-y-4 pt-6">
					<div className="flex flex-col items-center gap-2 py-2">
						<div className="flex -space-x-3">
							<Avatar className="border-2 border-background">
								<AvatarFallback>AB</AvatarFallback>
							</Avatar>
							<Avatar className="border-2 border-background">
								<AvatarFallback>CD</AvatarFallback>
							</Avatar>
						</div>
						<h4 className="font-medium text-sm">No Team Members</h4>
						<p className="text-xs text-muted-foreground text-center">
							Invite your team to collaborate on this project.
						</p>
						<Button variant="outline" size="sm">
							<Plus className="mr-1 size-3" /> Invite Members
						</Button>
					</div>
				</CardContent>
			</Card>

			{/* Data Table */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Recent Invoices</CardTitle>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Invoice</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="text-right">Amount</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							<TableRow>
								<TableCell className="font-medium">INV-001</TableCell>
								<TableCell>
									<Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600">
										Paid
									</Badge>
								</TableCell>
								<TableCell className="text-right">$250.00</TableCell>
							</TableRow>
							<TableRow>
								<TableCell className="font-medium">INV-002</TableCell>
								<TableCell>
									<Badge variant="secondary">Pending</Badge>
								</TableCell>
								<TableCell className="text-right">$150.00</TableCell>
							</TableRow>
							<TableRow>
								<TableCell className="font-medium">INV-003</TableCell>
								<TableCell>
									<Badge variant="secondary" className="bg-red-500/10 text-red-600">
										Overdue
									</Badge>
								</TableCell>
								<TableCell className="text-right">$350.00</TableCell>
							</TableRow>
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			{/* Skeleton Loading */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Loading States</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex items-center gap-3">
						<Skeleton className="size-10 rounded-full" />
						<div className="flex-1 space-y-2">
							<Skeleton className="h-4 w-3/4" />
							<Skeleton className="h-3 w-1/2" />
						</div>
					</div>
					<Skeleton className="h-24 w-full" />
					<div className="flex gap-2">
						<Skeleton className="h-9 w-20" />
						<Skeleton className="h-9 w-20" />
					</div>
				</CardContent>
			</Card>

			{/* Progress & Stats */}
			<Card>
				<CardContent className="space-y-4 pt-6">
					<Tabs defaultValue="overview">
						<TabsList className="w-full">
							<TabsTrigger value="overview" className="flex-1">
								Overview
							</TabsTrigger>
							<TabsTrigger value="analytics" className="flex-1">
								Analytics
							</TabsTrigger>
						</TabsList>
						<TabsContent value="overview" className="mt-3 space-y-3">
							<div className="space-y-1">
								<div className="flex justify-between text-sm">
									<span>Storage</span>
									<span className="text-muted-foreground">75%</span>
								</div>
								<Progress value={75} />
							</div>
							<div className="space-y-1">
								<div className="flex justify-between text-sm">
									<span>Bandwidth</span>
									<span className="text-muted-foreground">45%</span>
								</div>
								<Progress value={45} />
							</div>
							<div className="space-y-1">
								<div className="flex justify-between text-sm">
									<span>Requests</span>
									<span className="text-muted-foreground">92%</span>
								</div>
								<Progress value={92} />
							</div>
						</TabsContent>
						<TabsContent value="analytics" className="mt-3 space-y-3">
							<div className="space-y-1">
								<div className="flex justify-between text-sm">
									<span>Page Views</span>
									<span className="font-medium">12,543</span>
								</div>
								<Progress value={62} />
							</div>
							<div className="space-y-1">
								<div className="flex justify-between text-sm">
									<span>Bounce Rate</span>
									<span className="font-medium">24%</span>
								</div>
								<Progress value={24} />
							</div>
							<div className="space-y-1">
								<div className="flex justify-between text-sm">
									<span>Avg. Session</span>
									<span className="font-medium">3m 42s</span>
								</div>
								<Progress value={55} />
							</div>
						</TabsContent>
					</Tabs>
				</CardContent>
			</Card>

			{/* Accordion */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">FAQ</CardTitle>
				</CardHeader>
				<CardContent>
					<Accordion type="single" collapsible defaultValue="item-1">
						<AccordionItem value="item-1">
							<AccordionTrigger className="text-sm">What components are included?</AccordionTrigger>
							<AccordionContent>
								All 57 shadcn/ui components are pre-installed and ready to import.
							</AccordionContent>
						</AccordionItem>
						<AccordionItem value="item-2">
							<AccordionTrigger className="text-sm">How do I deploy?</AccordionTrigger>
							<AccordionContent>
								Run <code className="bg-muted px-1 rounded">jack ship</code> to deploy to production
								instantly.
							</AccordionContent>
						</AccordionItem>
						<AccordionItem value="item-3">
							<AccordionTrigger className="text-sm">Is there a database?</AccordionTrigger>
							<AccordionContent>
								Yes, D1 SQLite database is included and globally replicated.
							</AccordionContent>
						</AccordionItem>
					</Accordion>
				</CardContent>
			</Card>

			{/* Buttons Grid */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Button Variants</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="flex flex-wrap gap-2">
						<Button size="sm">Primary</Button>
						<Button size="sm" variant="secondary">
							Secondary
						</Button>
						<Button size="sm" variant="outline">
							Outline
						</Button>
						<Button size="sm" variant="destructive">
							Destructive
						</Button>
						<Button size="sm" variant="ghost">
							Ghost
						</Button>
						<Button size="sm" variant="link">
							Link
						</Button>
					</div>
					<Separator />
					<div className="flex flex-wrap gap-2">
						<Button size="sm" disabled>
							<Loader2 className="mr-1 size-3 animate-spin" />
							Loading
						</Button>
						<Button size="sm" variant="outline">
							<CreditCard className="mr-1 size-3" />
							Pay Now
						</Button>
						<Button size="sm" variant="outline">
							<Archive className="mr-1 size-3" />
							Archive
						</Button>
						<Button size="sm" variant="outline">
							<Flag className="mr-1 size-3" />
							Flag
						</Button>
					</div>
				</CardContent>
			</Card>

			{/* Alerts */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Alerts</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<Alert>
						<Terminal className="size-4" />
						<AlertTitle>Heads up!</AlertTitle>
						<AlertDescription>You can add components using the CLI.</AlertDescription>
					</Alert>
					<Alert variant="destructive">
						<AlertCircle className="size-4" />
						<AlertTitle>Error</AlertTitle>
						<AlertDescription>Your session has expired. Please log in again.</AlertDescription>
					</Alert>
					<Alert className="border-blue-500/50 text-blue-600 [&>svg]:text-blue-600">
						<Info className="size-4" />
						<AlertTitle>Note</AlertTitle>
						<AlertDescription>This feature is in beta. Feedback welcome.</AlertDescription>
					</Alert>
				</CardContent>
			</Card>

			{/* Calendar */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Date Picker</CardTitle>
				</CardHeader>
				<CardContent className="flex justify-center">
					<Calendar
						mode="single"
						selected={selectedDate}
						onSelect={setSelectedDate}
						className="rounded-md border"
					/>
				</CardContent>
			</Card>

			{/* Dialog & Sheet */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Overlays</CardTitle>
					<p className="text-sm text-muted-foreground">Dialog, Sheet & Popover components</p>
				</CardHeader>
				<CardContent className="space-y-3">
					<Dialog>
						<DialogTrigger asChild>
							<Button variant="outline" className="w-full">
								Open Dialog
							</Button>
						</DialogTrigger>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Edit Profile</DialogTitle>
								<DialogDescription>
									Make changes to your profile here. Click save when done.
								</DialogDescription>
							</DialogHeader>
							<div className="space-y-3 py-4">
								<div className="space-y-1">
									<Label htmlFor="dialog-name">Name</Label>
									<Input id="dialog-name" defaultValue="John Doe" />
								</div>
								<div className="space-y-1">
									<Label htmlFor="dialog-email">Email</Label>
									<Input id="dialog-email" defaultValue="john@example.com" />
								</div>
							</div>
							<DialogFooter>
								<Button type="submit">Save changes</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>
					<Sheet>
						<SheetTrigger asChild>
							<Button variant="outline" className="w-full">
								Open Sheet
							</Button>
						</SheetTrigger>
						<SheetContent>
							<SheetHeader>
								<SheetTitle>Notifications</SheetTitle>
								<SheetDescription>You have 3 unread notifications.</SheetDescription>
							</SheetHeader>
							<div className="mt-4 space-y-3">
								{[
									{ icon: Mail, title: "New message", desc: "from Alice" },
									{ icon: Bell, title: "Reminder", desc: "Team meeting at 3pm" },
									{ icon: FileText, title: "Document shared", desc: "Q4 Report" },
								].map((item) => (
									<div key={item.title} className="flex items-start gap-3 rounded-lg border p-3">
										<item.icon className="mt-0.5 size-4 text-muted-foreground" />
										<div>
											<p className="text-sm font-medium">{item.title}</p>
											<p className="text-xs text-muted-foreground">{item.desc}</p>
										</div>
									</div>
								))}
							</div>
						</SheetContent>
					</Sheet>
					<Popover>
						<PopoverTrigger asChild>
							<Button variant="outline" className="w-full">
								Open Popover
							</Button>
						</PopoverTrigger>
						<PopoverContent className="w-80">
							<div className="space-y-2">
								<h4 className="font-medium text-sm">Dimensions</h4>
								<p className="text-xs text-muted-foreground">Set the dimensions for the layer.</p>
								<div className="grid grid-cols-2 gap-2">
									<div className="space-y-1">
										<Label className="text-xs">Width</Label>
										<Input defaultValue="100%" className="h-8" />
									</div>
									<div className="space-y-1">
										<Label className="text-xs">Height</Label>
										<Input defaultValue="25px" className="h-8" />
									</div>
								</div>
							</div>
						</PopoverContent>
					</Popover>
				</CardContent>
			</Card>

			{/* Breadcrumb & Navigation */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Navigation</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<Breadcrumb>
						<BreadcrumbList>
							<BreadcrumbItem>
								<BreadcrumbLink href="#">
									<Home className="size-3.5" />
								</BreadcrumbLink>
							</BreadcrumbItem>
							<BreadcrumbSeparator />
							<BreadcrumbItem>
								<BreadcrumbLink href="#">Components</BreadcrumbLink>
							</BreadcrumbItem>
							<BreadcrumbSeparator />
							<BreadcrumbItem>
								<BreadcrumbPage>Breadcrumb</BreadcrumbPage>
							</BreadcrumbItem>
						</BreadcrumbList>
					</Breadcrumb>
					<Separator />
					<div className="flex items-center gap-1">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button variant="ghost" size="icon" className="size-8">
									<Home className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Home</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button variant="ghost" size="icon" className="size-8">
									<Settings className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Settings</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button variant="ghost" size="icon" className="size-8">
									<User className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Profile</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button variant="ghost" size="icon" className="size-8">
									<Bell className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>Notifications</TooltipContent>
						</Tooltip>
					</div>
					<Separator />
					<div className="flex items-center gap-2">
						<Badge variant="outline">v2.4.0</Badge>
						<Badge
							variant="outline"
							className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
						>
							Stable
						</Badge>
						<Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/20">
							Latest
						</Badge>
					</div>
				</CardContent>
			</Card>

			{/* OTP Input */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Verification Code</CardTitle>
					<p className="text-sm text-muted-foreground">
						Enter the 6-digit code sent to your email.
					</p>
				</CardHeader>
				<CardContent className="flex flex-col items-center gap-4">
					<InputOTP maxLength={6} defaultValue="482">
						<InputOTPGroup>
							<InputOTPSlot index={0} />
							<InputOTPSlot index={1} />
							<InputOTPSlot index={2} />
						</InputOTPGroup>
						<InputOTPSeparator />
						<InputOTPGroup>
							<InputOTPSlot index={3} />
							<InputOTPSlot index={4} />
							<InputOTPSlot index={5} />
						</InputOTPGroup>
					</InputOTP>
					<p className="text-xs text-muted-foreground">
						Didn&apos;t receive a code?{" "}
						<button type="button" className="underline underline-offset-4">
							Resend
						</button>
					</p>
				</CardContent>
			</Card>

			{/* Command Palette */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Command Palette</CardTitle>
				</CardHeader>
				<CardContent>
					<Command className="rounded-lg border">
						<CommandInput placeholder="Type a command or search..." />
						<CommandList>
							<CommandEmpty>No results found.</CommandEmpty>
							<CommandGroup heading="Suggestions">
								<CommandItem>
									<CalendarIcon className="mr-2 size-4" />
									<span>Calendar</span>
								</CommandItem>
								<CommandItem>
									<Search className="mr-2 size-4" />
									<span>Search</span>
								</CommandItem>
								<CommandItem>
									<Settings className="mr-2 size-4" />
									<span>Settings</span>
								</CommandItem>
							</CommandGroup>
							<CommandSeparator />
							<CommandGroup heading="Settings">
								<CommandItem>
									<User className="mr-2 size-4" />
									<span>Profile</span>
								</CommandItem>
								<CommandItem>
									<Mail className="mr-2 size-4" />
									<span>Mail</span>
								</CommandItem>
							</CommandGroup>
						</CommandList>
					</Command>
				</CardContent>
			</Card>

			{/* Collapsible + HoverCard */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Expandable Sections</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen}>
						<div className="flex items-center justify-between rounded-lg border px-3 py-2">
							<span className="text-sm font-medium">3 starred repositories</span>
							<CollapsibleTrigger asChild>
								<Button variant="ghost" size="icon" className="size-7">
									<ChevronsUpDown className="size-3.5" />
								</Button>
							</CollapsibleTrigger>
						</div>
						<CollapsibleContent className="mt-2 space-y-2">
							{["shadcn/ui", "vercel/next.js", "tailwindlabs/tailwindcss"].map((repo) => (
								<div key={repo} className="rounded-lg border px-3 py-2 text-sm">
									{repo}
								</div>
							))}
						</CollapsibleContent>
					</Collapsible>
					<Separator />
					<div className="flex items-center gap-2">
						<span className="text-sm">Hover for info:</span>
						<HoverCard>
							<HoverCardTrigger asChild>
								<Button variant="link" className="h-auto p-0 text-sm">
									@shadcn
								</Button>
							</HoverCardTrigger>
							<HoverCardContent className="w-72">
								<div className="flex gap-3">
									<Avatar>
										<AvatarFallback>SC</AvatarFallback>
									</Avatar>
									<div className="space-y-1">
										<h4 className="text-sm font-semibold">@shadcn</h4>
										<p className="text-xs text-muted-foreground">
											Creator of shadcn/ui. Building in the open.
										</p>
										<div className="flex items-center text-xs text-muted-foreground">
											<CalendarIcon className="mr-1 size-3" />
											Joined December 2021
										</div>
									</div>
								</div>
							</HoverCardContent>
						</HoverCard>
					</div>
				</CardContent>
			</Card>

			{/* Carousel */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Carousel</CardTitle>
				</CardHeader>
				<CardContent>
					<Carousel className="mx-auto w-full max-w-xs">
						<CarouselContent>
							{Array.from({ length: 5 }, (_, i) => (
								<CarouselItem key={`slide-${i + 1}`}>
									<div className="p-1">
										<Card>
											<CardContent className="flex aspect-square items-center justify-center p-6">
												<span className="text-3xl font-semibold">{i + 1}</span>
											</CardContent>
										</Card>
									</div>
								</CarouselItem>
							))}
						</CarouselContent>
						<CarouselPrevious />
						<CarouselNext />
					</Carousel>
				</CardContent>
			</Card>

			{/* Scroll Area + Tags */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Components List</CardTitle>
					<p className="text-sm text-muted-foreground">Scroll to explore all 57 components</p>
				</CardHeader>
				<CardContent>
					<ScrollArea className="h-48 rounded-md border">
						<div className="p-4 space-y-2">
							{[
								"Accordion",
								"Alert",
								"Alert Dialog",
								"Aspect Ratio",
								"Avatar",
								"Badge",
								"Breadcrumb",
								"Button",
								"Calendar",
								"Card",
								"Carousel",
								"Chart",
								"Checkbox",
								"Collapsible",
								"Combobox",
								"Command",
								"Context Menu",
								"Dialog",
								"Drawer",
								"Dropdown Menu",
								"Form",
								"Hover Card",
								"Input",
								"Input OTP",
								"Label",
								"Menubar",
								"Navigation Menu",
								"Pagination",
								"Popover",
								"Progress",
								"Radio Group",
								"Resizable",
								"Scroll Area",
								"Select",
								"Separator",
								"Sheet",
								"Sidebar",
								"Skeleton",
								"Slider",
								"Sonner",
								"Spinner",
								"Switch",
								"Table",
								"Tabs",
								"Textarea",
								"Toggle",
								"Toggle Group",
								"Tooltip",
							].map((comp) => (
								<div
									key={comp}
									className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-muted"
								>
									<span>{comp}</span>
									<Badge variant="outline" className="text-xs">
										installed
									</Badge>
								</div>
							))}
						</div>
					</ScrollArea>
				</CardContent>
			</Card>

			{/* Theme Toggle Card */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Appearance</CardTitle>
					<p className="text-sm text-muted-foreground">Customize your experience</p>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid grid-cols-3 gap-2">
						{[
							{ icon: Sun, label: "Light" },
							{ icon: Moon, label: "Dark" },
							{ icon: Laptop, label: "System" },
						].map((theme) => (
							<Button
								key={theme.label}
								variant={theme.label === "System" ? "default" : "outline"}
								size="sm"
								className="flex-col gap-1 h-auto py-3"
							>
								<theme.icon className="size-4" />
								<span className="text-xs">{theme.label}</span>
							</Button>
						))}
					</div>
					<Separator />
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm font-medium">Notifications</p>
								<p className="text-xs text-muted-foreground">Receive push notifications</p>
							</div>
							<Switch defaultChecked />
						</div>
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm font-medium">Marketing emails</p>
								<p className="text-xs text-muted-foreground">Receive emails about new features</p>
							</div>
							<Switch />
						</div>
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm font-medium">Social notifications</p>
								<p className="text-xs text-muted-foreground">
									Receive notifications for friend requests
								</p>
							</div>
							<Switch defaultChecked />
						</div>
					</div>
				</CardContent>
			</Card>

			{/* User Profile Card */}
			<Card>
				<CardContent className="pt-6">
					<div className="flex flex-col items-center gap-3 text-center">
						<Avatar className="size-16">
							<AvatarFallback className="text-lg">JD</AvatarFallback>
						</Avatar>
						<div>
							<h4 className="font-semibold">Jane Doe</h4>
							<p className="text-sm text-muted-foreground">jane@example.com</p>
						</div>
						<div className="flex gap-4 text-center">
							<div>
								<p className="text-lg font-semibold">142</p>
								<p className="text-xs text-muted-foreground">Posts</p>
							</div>
							<Separator orientation="vertical" className="h-10" />
							<div>
								<p className="text-lg font-semibold">2.4k</p>
								<p className="text-xs text-muted-foreground">Followers</p>
							</div>
							<Separator orientation="vertical" className="h-10" />
							<div>
								<p className="text-lg font-semibold">891</p>
								<p className="text-xs text-muted-foreground">Following</p>
							</div>
						</div>
						<div className="flex gap-2 w-full">
							<Button size="sm" className="flex-1">
								Follow
							</Button>
							<Button size="sm" variant="outline" className="flex-1">
								Message
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
